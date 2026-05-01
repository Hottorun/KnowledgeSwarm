import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { STUB_TRIPLES } from '../stubs/fixtures';
import type { BranchPlan, DocumentChunk, Triple, WorkerOutput } from '../types';
import type { SpecialistProfile } from './specialists';
import { parseJsonArrayPropertyItems, parseJsonObject } from './json';
import { withAnthropicLimit } from './anthropicLimiter';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a knowledge extraction worker. Extract Subject-Predicate-Object triples from a document chunk.

Output ONLY valid JSON — no markdown, no explanation:
{"triples":[{"subject":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"predicate":"verb_phrase","object":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"confidence":0.0,"sources":[{"url":"document","title":"Document","snippet":"exact quote"}],"properties":{}}]}

Rules:
- Node ID format: type:slug (e.g. company:acme-corp, person:jane-doe, obligation:monthly-payment)
- Extract ONLY facts explicitly stated in the text — never hallucinate
- Extract at least 5 concrete triples when the chunk contains explicit relationships
- Extract at most 10 triples per chunk
- Prefer triples that connect entities back to the central company, organization, product, document, or topic in the chunk
- Confidence: 0.9+ explicit | 0.7–0.9 strong implication | 0.5–0.7 inference — discard below 0.5
- Use the exact quoted text as the source snippet
- Keep JSON compact`;

export async function runWorker(
  chunk: DocumentChunk,
  focusNodeTypes: string[],
  specialist: SpecialistProfile,
  branch: BranchPlan,
  documentName: string
): Promise<WorkerOutput> {
  if (config.stubMode) {
    console.log(`  [${specialist.agentName}] stub - chunk ${chunk.index}`);
    return { triples: withProvenance(STUB_TRIPLES, specialist, branch, chunk.index, documentName) };
  }

  const userMessage = `Specialist: ${specialist.agentName}
Extraction focus: ${specialist.extractionHint}
Preferred predicates: ${specialist.preferredPredicates.join(', ')}
Focus entity types: ${[...new Set([...focusNodeTypes, ...specialist.nodeTypes])].join(', ')}
Branch: ${branch.label} - ${branch.focus}
Source document: ${documentName}

Document chunk ${chunk.index}:

${chunk.text}`;

  const response = await withAnthropicLimit(() => client.messages.create({
    model: config.workerModel,
    max_tokens: 1800,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  }));

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const output = parseWorkerOutput(text);
  return {
    triples: withProvenance(normalizeWorkerTriples(output.triples ?? []), specialist, branch, chunk.index, documentName),
  };
}

function parseWorkerOutput(text: string): WorkerOutput {
  try {
    return parseJsonObject<WorkerOutput>(text);
  } catch (error) {
    const triples = parseJsonArrayPropertyItems(text, 'triples') as Triple[];
    if (triples.length > 0) {
      console.warn(`[worker] repaired malformed JSON output; salvaged ${triples.length} triple(s)`);
      return { triples };
    }

    throw error;
  }
}

function normalizeWorkerTriples(triples: Triple[]): Triple[] {
  return triples
    .filter(triple => triple?.subject?.label && triple?.predicate && triple?.object?.label)
    .map(triple => ({
      ...triple,
      subject: {
        id: triple.subject.id || makeId(triple.subject.type || 'Entity', triple.subject.label),
        label: triple.subject.label,
        type: triple.subject.type || 'Entity',
        properties: triple.subject.properties || {},
      },
      object: {
        id: triple.object.id || makeId(triple.object.type || 'Entity', triple.object.label),
        label: triple.object.label,
        type: triple.object.type || 'Entity',
        properties: triple.object.properties || {},
      },
      confidence: typeof triple.confidence === 'number' ? triple.confidence : 0.75,
      sources: triple.sources || [],
      properties: triple.properties || {},
    }));
}

function makeId(type: string, label: string): string {
  return `${type.toLowerCase()}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function withProvenance(
  triples: Triple[],
  specialist: SpecialistProfile,
  branch: BranchPlan,
  chunkIndex: number,
  documentName: string
): Triple[] {
  return triples.map(triple => ({
    ...triple,
    sources: normalizeSources(triple.sources, documentName),
    properties: {
      ...(triple.properties ?? {}),
      specialist: specialist.kind,
      branchId: branch.id,
      chunkIndex,
      documentName,
    },
  }));
}

function normalizeSources(sources: Triple['sources'], documentName: string): Triple['sources'] {
  if (!sources || sources.length === 0) {
    return [{ url: `local://${encodeURIComponent(documentName)}`, title: documentName }];
  }

  return sources.map(source => {
    const title = source.title && source.title.toLowerCase() !== 'document'
      ? source.title
      : documentName;
    const url = source.url && source.url !== 'document'
      ? source.url
      : `local://${encodeURIComponent(documentName)}`;

    return { ...source, title, url };
  });
}
