import { config } from './config';
import { decomposeDocument } from './agents/meta';
import { runSupervisor } from './agents/supervisor';
import { specialistForBranch } from './agents/specialists';
import { emitAgentEvent, emitTriples, setEmitCallbacks, EmitCallbacks } from './tools/emit';
import { normalizeTriples, normalizeAndDeduplicate } from './ingest/normalizer';
import { chunkText, buildDocumentSummary } from './ingest/chunker';
export { expandNode } from './agents/expander';

export interface OrchestratorCallbacks extends EmitCallbacks {
  // Additional orchestrator-level callbacks can be added here
}

export async function orchestrate(
  runId: string,
  documentText: string,
  documentName = 'input',
  callbacks?: OrchestratorCallbacks,
): Promise<void> {
  if (callbacks) {
    setEmitCallbacks(callbacks);
  }

  console.log(`\n[orchestrator] run=${runId} stub=${config.stubMode}`);

  await emitAgentEvent(runId, 'MetaAgent', 'chunking', `Splitting ${documentName} into chunks`);

  const chunks = chunkText(documentText);
  console.log(`[ingest] ${chunks.length} chunk(s)`);

  const summary = buildDocumentSummary(documentText, config.metaSummaryChars);

  await emitAgentEvent(runId, 'MetaAgent', 'decomposing', 'Analyzing document structure');
  const { documentType, branches } = await decomposeDocument(summary);

  console.log(`[meta] documentType=${documentType}, ${branches.length} branch(es):`);
  branches.forEach(b => console.log(`  - ${b.id}: ${b.label}`));
  const specialists = branches.map(specialistForBranch);
  specialists.forEach((specialist, i) =>
    console.log(`  -> ${branches[i].id}: ${specialist.agentName} (${specialist.kind})`)
  );

  // Every branch processes every chunk — each specialist extracts what's relevant
  // to their focus from the full document, deduplication handles the overlap.
  const branchChunks = branches.map(() => chunks);

  await emitAgentEvent(runId, 'MetaAgent', 'dispatching', `${branches.length} specialists in parallel`, {
    documentType,
    specialists: specialists.map((specialist, i) => ({
      branchId: branches[i].id,
      branchLabel: branches[i].label,
      agentName: specialist.agentName,
      kind: specialist.kind,
    })),
  });

  // Track already-emitted triple keys to avoid duplicates across branches
  const emittedKeys = new Set<string>();
  let totalNormalized = 0;

  // Process branches as they complete (not all at once)
  type BranchResult =
    | { status: 'fulfilled'; value: Awaited<ReturnType<typeof runSupervisor>>; branch: typeof branches[number]; i: number }
    | { status: 'rejected'; reason: unknown; branch: typeof branches[number]; i: number };
  type BranchTask = Promise<{ result: BranchResult; task: BranchTask }>;

  const branchPromises: BranchTask[] = branches.map((branch, i) => {
    const work: Promise<BranchResult> = runSupervisor(runId, branch, branchChunks[i], specialists[i], documentName)
      .then(triples => ({ status: 'fulfilled' as const, value: triples, branch, i }))
      .catch(error => ({ status: 'rejected' as const, reason: error, branch, i }));

    let task: BranchTask;
    task = work.then(result => ({ result, task }));
    return task;
  });

  // Poll for completed branches and emit incrementally
  const pending = new Set(branchPromises);
  while (pending.size > 0) {
    const { result, task } = await Promise.race(pending);
    pending.delete(task);

    if (result.status === 'fulfilled') {
      const { value: triples, branch } = result;
      console.log(`[orchestrator] branch "${branch.id}" completed with ${triples.length} triples`);

      if (triples.length > 0) {
        await emitAgentEvent(runId, 'MetaAgent', 'normalizing', `Deduplicating branch "${branch.label}"`);
        const newTriples = normalizeAndDeduplicate(triples, emittedKeys);
        console.log(`[orchestrator] branch "${branch.id}": ${triples.length} raw → ${newTriples.length} new triples`);
        if (newTriples.length > 0) {
          await emitTriples(runId, 'MetaAgent', newTriples);
          totalNormalized += newTriples.length;
        }
      }
    } else {
      console.error(`[orchestrator] branch "${result.branch.id}" failed:`, result.reason);
    }
  }

  console.log(`[orchestrator] total normalized triples: ${totalNormalized}`);
  if (totalNormalized === 0) {
    await emitAgentEvent(runId, 'MetaAgent', 'failed', 'Swarm extracted 0 triples; falling back to generic extraction');
    throw new Error('Swarm extracted 0 triples');
  }

  await emitAgentEvent(runId, 'MetaAgent', 'completed', `Done. ${totalNormalized} triples in graph`);
}

async function main() {
  const { STUB_DOCUMENT_TEXT } = await import('./stubs/fixtures');

  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  const cliRunId = flags['run-id'];
  const useStdin = flags['stdin'] === 'true';
  const documentName = flags['document-name'] || 'input';

  let documentText: string;

  if (useStdin) {
    documentText = await readStdin();
  } else if (positional.length > 0) {
    documentText = positional[0];
  } else {
    documentText = STUB_DOCUMENT_TEXT;
  }

  let runId: string;

  if (config.stubMode) {
    runId = `stub-run-${Date.now()}`;
    console.log(`[stub] runId: ${runId}`);
  } else if (cliRunId) {
    runId = cliRunId;
    console.log(`[api] using provided runId: ${runId}`);
  } else {
    const res = await fetch(`${config.apiBaseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: documentText.slice(0, 200) }),
    });
    if (!res.ok) {
      console.error(`Failed to create run: ${res.status}. Is the API running at ${config.apiBaseUrl}?`);
      process.exit(1);
    }
    const data = (await res.json()) as { runId: string };
    runId = data.runId;
    console.log(`[api] created run: ${runId}`);
  }

  await orchestrate(runId, documentText, documentName);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('[orchestrator] fatal:', err);
    process.exit(1);
  });
}
