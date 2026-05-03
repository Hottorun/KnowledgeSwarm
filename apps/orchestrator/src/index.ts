import { config } from './config';
import { decomposeDocument } from './agents/meta';
import { runSupervisor } from './agents/supervisor';
import { decideSpecialistRouting, specialistForBranch } from './agents/specialists';
import { repairDisconnectedGraph } from './agents/graphRepair';
import { detectMainEntity, fallbackMainEntityFromDocument, type MainEntityDetection } from './agents/mainEntity';
import { classifyDocument } from './agents/classifier';
import { emitAgentEvent, emitTriples, setEmitCallbacks, EmitCallbacks } from './tools/emit';
import { analyzeConnectedComponents, normalizeAndDeduplicate, normalizeTriples } from './ingest/normalizer';
import { chunkText, buildDocumentSummary } from './ingest/chunker';
import {
  annotateTriplesForPresentation,
  buildPresentationTriples,
  summarizeDocumentText,
  type DocumentCategoryAssignment,
} from './ingest/presentation';
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

  const effectiveDocumentText = limitDocumentText(documentText);
  if (effectiveDocumentText.length < documentText.length) {
    await emitAgentEvent(
      runId,
      'MetaAgent',
      'sampling',
      `Large input detected; sampled ${effectiveDocumentText.length.toLocaleString()} of ${documentText.length.toLocaleString()} characters`
    );
  }

  await emitAgentEvent(runId, 'MetaAgent', 'chunking', `Splitting ${documentName} into chunks`);

  let chunks = chunkText(effectiveDocumentText);
  if (chunks.length > config.maxChunks) {
    await emitAgentEvent(runId, 'MetaAgent', 'sampling', `Using ${config.maxChunks} of ${chunks.length} chunks to keep extraction responsive`);
    chunks = chunks.slice(0, config.maxChunks).map((chunk, index) => ({ ...chunk, index }));
  }
  console.log(`[ingest] ${chunks.length} chunk(s)`);

  const summary = buildDocumentSummary(effectiveDocumentText, config.metaSummaryChars);
  const documentSummaries = new Map<string, string>([
    [documentName, summarizeDocumentText(effectiveDocumentText)],
  ]);

  // Classify the document up front so the presentation scaffold uses the
  // model's primary category instead of the keyword-based dominantCategory
  // fallback. Runs in parallel with decomposition since both consume the
  // document summary and have no ordering dependency.
  const [{ documentType, branches }, classification] = await Promise.all([
    (async () => {
      await emitAgentEvent(runId, 'MetaAgent', 'decomposing', 'Analyzing document structure');
      return decomposeDocument(summary);
    })(),
    classifyDocument(runId, documentName, summary),
  ]);

  const documentClassifications = new Map<string, DocumentCategoryAssignment>([
    [documentName, {
      primaryCategory: classification.primaryCategory,
      secondaryCategories: classification.secondaryCategories,
      source: classification.source,
    }],
  ]);

  console.log(`[meta] documentType=${documentType}, ${branches.length} branch(es):`);
  branches.forEach(b => console.log(`  - ${b.id}: ${b.label}`));
  const allSpecialists = branches.map(specialistForBranch);
  allSpecialists.forEach((specialist, i) =>
    console.log(`  -> ${branches[i].id}: ${specialist.agentName} (${specialist.kind})`)
  );

  // Specialist routing by document classification: if the classifier is
  // confident about the document's category, drop specialists whose kind
  // doesn't fit that category. Conservative — when confidence is low or the
  // category is "other", we keep every specialist running so we never silently
  // lose facts. See `decideSpecialistRouting` in ./agents/specialists.ts.
  const routing = decideSpecialistRouting({
    available: allSpecialists.map(specialist => specialist.kind),
    primaryCategory: classification.primaryCategory,
    secondaryCategories: classification.secondaryCategories,
    confidence: classification.confidence,
  });

  const keptIndices = allSpecialists
    .map((specialist, i) => routing.keptKinds.includes(specialist.kind) ? i : -1)
    .filter(i => i >= 0);
  const branchesToRun = keptIndices.map(i => branches[i]);
  const specialists = keptIndices.map(i => allSpecialists[i]);
  const droppedSpecialists = allSpecialists.filter((_, i) => !keptIndices.includes(i));

  if (droppedSpecialists.length > 0) {
    console.log(`[routing] skipping ${droppedSpecialists.length} specialist(s) based on document category "${classification.primaryCategory}" (confidence=${classification.confidence.toFixed(2)})`);
    droppedSpecialists.forEach(specialist =>
      console.log(`  -> skip ${specialist.agentName} (${specialist.kind})`)
    );
  }
  await emitAgentEvent(runId, 'MetaAgent', 'routing', `Specialist routing: ${specialists.length} kept, ${droppedSpecialists.length} skipped`, {
    primaryCategory: classification.primaryCategory,
    secondaryCategories: classification.secondaryCategories,
    confidence: classification.confidence,
    routingSource: routing.source,
    kept: specialists.map(s => ({ kind: s.kind, agentName: s.agentName })),
    skipped: droppedSpecialists.map(s => ({ kind: s.kind, agentName: s.agentName })),
  });

  // Every branch processes every chunk — each specialist extracts what's relevant
  // to their focus from the full document, deduplication handles the overlap.
  const branchChunks = branchesToRun.map(() => chunks);

  await emitAgentEvent(runId, 'MetaAgent', 'dispatching', `${branchesToRun.length} specialists in parallel`, {
    documentType,
    specialists: specialists.map((specialist, i) => ({
      branchId: branchesToRun[i].id,
      branchLabel: branchesToRun[i].label,
      agentName: specialist.agentName,
      kind: specialist.kind,
    })),
  });

  const allExtractedTriples: Awaited<ReturnType<typeof runSupervisor>> = [];
  const emittedTripleKeys = new Set<string>();
  // Main entity is detected once after the first batch of triples comes in,
  // then reused for the rest of the run so the graph's center stays stable
  // even as more chunks land. Without this, every incremental rebuild could
  // reshuffle who the central node is, which makes the canvas feel jumpy.
  let mainEntityDetection: MainEntityDetection | null = null;

  // Process branches as they complete (not all at once)
  type BranchResult =
    | { status: 'fulfilled'; value: Awaited<ReturnType<typeof runSupervisor>>; branch: typeof branchesToRun[number]; i: number }
    | { status: 'rejected'; reason: unknown; branch: typeof branchesToRun[number]; i: number };
  type BranchTask = Promise<{ result: BranchResult; task: BranchTask }>;

  const branchPromises: BranchTask[] = branchesToRun.map((branch, i) => {
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
      allExtractedTriples.push(...triples);

      const incrementalAnnotated = annotateTriplesForPresentation(allExtractedTriples, documentName, documentClassifications);
      // First batch with extracted triples → run MainEntityAgent and lock in
      // the choice. Subsequent batches reuse it.
      if (!mainEntityDetection && incrementalAnnotated.length > 0) {
        mainEntityDetection = await detectMainEntity(runId, incrementalAnnotated, documentName);
      }
      const incrementalPresentation = buildPresentationTriples(
        incrementalAnnotated,
        documentName,
        documentSummaries,
        mainEntityDetection?.entity,
        documentClassifications,
      );
      const incrementalTriples = normalizeAndDeduplicate(
        [...incrementalAnnotated, ...incrementalPresentation],
        emittedTripleKeys,
      );
      if (incrementalTriples.length > 0) {
        await emitAgentEvent(
          runId,
          'MetaAgent',
          'presentation.streaming',
          `Streaming ${incrementalTriples.length} new graph triple(s) from ${branch.label}`
        );
        await emitTriples(runId, 'MetaAgent', incrementalTriples);
      }
    } else {
      console.error(`[orchestrator] branch "${result.branch.id}" failed:`, result.reason);
    }
  }

  await emitAgentEvent(runId, 'MetaAgent', 'normalizing', `Deduplicating ${allExtractedTriples.length} extracted triple(s)`);
  const annotatedTriples = annotateTriplesForPresentation(allExtractedTriples, documentName, documentClassifications);
  // If extraction returned 0 triples we never ran MainEntityAgent during the
  // streaming loop. Fall back to the document name so the graph still has a
  // center node and `presentationRole: 'main_entity'` is set somewhere.
  if (!mainEntityDetection) {
    mainEntityDetection = annotatedTriples.length > 0
      ? await detectMainEntity(runId, annotatedTriples, documentName)
      : fallbackMainEntityFromDocument(documentName);
  }
  const presentationTriples = buildPresentationTriples(
    annotatedTriples,
    documentName,
    documentSummaries,
    mainEntityDetection.entity,
    documentClassifications,
  );
  if (presentationTriples.length > 0) {
    await emitAgentEvent(
      runId,
      'MetaAgent',
      'presentation.scaffolded',
      `Added ${presentationTriples.length} category/document scaffold triple(s)`
    );
  }
  const normalized = normalizeTriples([...annotatedTriples, ...presentationTriples]);
  let finalTriples = normalized;
  let components = analyzeConnectedComponents(finalTriples);

  if (components.length > 1 && config.graphRepairEnabled) {
    await emitAgentEvent(
      runId,
      'ConnectivityAgent',
      'connectivity.check',
      `Graph has ${components.length} disconnected component(s); inferring bridge relationships`
    );

    const bridgeTriples = await repairDisconnectedGraph(finalTriples, components, documentName);
    if (bridgeTriples.length > 0) {
      finalTriples = normalizeTriples([...finalTriples, ...bridgeTriples]);
      components = analyzeConnectedComponents(finalTriples);
      await emitAgentEvent(
        runId,
        'ConnectivityAgent',
        'connectivity.repaired',
        `Added ${bridgeTriples.length} inferred bridge edge(s); graph now has ${components.length} component(s)`
      );
    }
  }

  if (components.length > 1) {
    await emitAgentEvent(
      runId,
      'ConnectivityAgent',
      'connectivity.warning',
      `Graph still has ${components.length} disconnected component(s) after repair`
    );
  }

  console.log(`[orchestrator] total normalized triples: ${normalized.length}, final triples: ${finalTriples.length}, components: ${components.length}`);
  if (finalTriples.length === 0) {
    await emitAgentEvent(runId, 'MetaAgent', 'failed', 'Swarm extracted 0 triples; falling back to generic extraction');
    throw new Error('Swarm extracted 0 triples');
  }

  const finalNewTriples = finalTriples.filter(triple => {
    const key = `${triple.subject.id}|${triple.predicate}|${triple.object.id}`;
    if (emittedTripleKeys.has(key)) return false;
    emittedTripleKeys.add(key);
    return true;
  });
  await emitTriples(runId, 'MetaAgent', finalNewTriples);
  await emitAgentEvent(runId, 'MetaAgent', 'completed', `Done. ${finalTriples.length} triples in graph (${components.length} component${components.length === 1 ? '' : 's'})`);
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

function limitDocumentText(text: string): string {
  if (text.length <= config.maxInputChars) return text;

  const half = Math.floor(config.maxInputChars / 2);
  return `${text.slice(0, half)}\n\n[...large document sampled...]\n\n${text.slice(-half)}`;
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
