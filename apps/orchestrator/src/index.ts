import { config } from './config';
import { decomposeDocument } from './agents/meta';
import { runSupervisor } from './agents/supervisor';
import { emitAgentEvent } from './tools/emit';
import { normalizeTriples } from './ingest/normalizer';
import { chunkText, buildDocumentSummary } from './ingest/chunker';
export { expandNode } from './agents/expander';

export async function orchestrate(runId: string, documentText: string): Promise<void> {
  console.log(`\n[orchestrator] run=${runId} stub=${config.stubMode}`);

  await emitAgentEvent(runId, 'MetaAgent', 'chunking', 'Splitting document into chunks');

  const chunks = chunkText(documentText);
  console.log(`[ingest] ${chunks.length} chunk(s)`);

  const summary = buildDocumentSummary(documentText, config.metaSummaryChars);

  await emitAgentEvent(runId, 'MetaAgent', 'decomposing', 'Analyzing document structure');
  const { documentType, branches } = await decomposeDocument(summary);

  console.log(`[meta] documentType=${documentType}, ${branches.length} branch(es):`);
  branches.forEach(b => console.log(`  - ${b.id}: ${b.label}`));

  // Distribute chunks across branches round-robin
  const branchChunks = branches.map(() => [] as typeof chunks);
  chunks.forEach((chunk, i) => branchChunks[i % branches.length].push(chunk));

  await emitAgentEvent(runId, 'MetaAgent', 'dispatching', `${branches.length} branches in parallel`);

  const results = await Promise.allSettled(
    branches.map((branch, i) => runSupervisor(runId, branch, branchChunks[i]))
  );

  const allTriples = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[orchestrator] branch "${branches[i].id}" failed:`, r.reason);
    }
  });

  await emitAgentEvent(runId, 'MetaAgent', 'normalizing', 'Deduplicating and normalizing entities');
  const normalized = normalizeTriples(allTriples);

  console.log(`[orchestrator] ${allTriples.length} raw → ${normalized.length} normalized triples`);
  await emitAgentEvent(runId, 'MetaAgent', 'completed', `Done. ${normalized.length} triples in graph`);
}

// Standalone entry point for CLI testing
async function main() {
  const { STUB_DOCUMENT_TEXT } = await import('./stubs/fixtures');

  const prompt = process.argv[2];
  const documentText = prompt ?? STUB_DOCUMENT_TEXT;

  let runId: string;

  if (config.stubMode) {
    runId = `stub-run-${Date.now()}`;
    console.log(`[stub] runId: ${runId}`);
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

  await orchestrate(runId, documentText);
}

main().catch(err => {
  console.error('[orchestrator] fatal:', err);
  process.exit(1);
});
