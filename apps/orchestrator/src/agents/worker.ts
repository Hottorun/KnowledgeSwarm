import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { STUB_TRIPLES } from '../stubs/fixtures';
import type { DocumentChunk, WorkerOutput } from '../types';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a knowledge extraction worker. Extract Subject-Predicate-Object triples from a document chunk.

Output ONLY valid JSON — no markdown, no explanation:
{"triples":[{"subject":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"predicate":"verb_phrase","object":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"confidence":0.0,"sources":[{"url":"document","title":"Document","snippet":"exact quote"}],"properties":{}}]}

Rules:
- Node ID format: type:slug (e.g. company:acme-corp, person:jane-doe, obligation:monthly-payment)
- Extract ONLY facts explicitly stated in the text — never hallucinate
- Confidence: 0.9+ explicit | 0.7–0.9 strong implication | 0.5–0.7 inference — discard below 0.5
- Use the exact quoted text as the source snippet
- Keep JSON compact`;

export async function runWorker(
  chunk: DocumentChunk,
  focusNodeTypes: string[]
): Promise<WorkerOutput> {
  if (config.stubMode) {
    console.log(`  [worker] stub — chunk ${chunk.index}`);
    return { triples: STUB_TRIPLES };
  }

  const userMessage = `Focus entity types: ${focusNodeTypes.join(', ')}\n\nDocument chunk ${chunk.index}:\n\n${chunk.text}`;

  const response = await client.messages.create({
    model: config.workerModel,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  return JSON.parse(text) as WorkerOutput;
}
