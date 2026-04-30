import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import type { BranchPlan, DocumentChunk, Triple, SupervisorOutput } from '../types';
import { emitAgentEvent, emitTriples } from '../tools/emit';
import { runWorker } from './worker';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a research supervisor. Review extracted knowledge triples and filter for quality.

Output ONLY valid JSON — no markdown, no explanation:
{"approved":[...triples...],"rejected":[{"triple":{...},"reason":"short reason"}]}

Reject triples that:
- Have vague predicates like "is", "has", "exists"
- Have non-specific node IDs like "entity:unknown"
- Are obvious duplicates of another triple in the list
- Have no supporting source snippet`;

export async function runSupervisor(
  runId: string,
  branch: BranchPlan,
  chunks: DocumentChunk[]
): Promise<Triple[]> {
  const supervisorName = `Supervisor:${branch.label}`;

  await emitAgentEvent(runId, supervisorName, 'started', `Branch: ${branch.label} — ${chunks.length} chunk(s)`);

  const workerResults = await Promise.all(
    chunks.map(async chunk => {
      const workerName = `Worker:${branch.id}`;
      await emitAgentEvent(runId, workerName, 'extracting', `Chunk ${chunk.index} (${chunk.text.length} chars)`);
      const output = await runWorker(chunk, branch.nodeTypes);
      await emitAgentEvent(runId, workerName, 'done', `${output.triples.length} triple(s) from chunk ${chunk.index}`);
      return output.triples;
    })
  );

  const allTriples = workerResults.flat();
  await emitAgentEvent(runId, supervisorName, 'reviewing', `Reviewing ${allTriples.length} raw triple(s)`);

  const approved = await supervisorReview(branch, allTriples);

  await emitAgentEvent(runId, supervisorName, 'done', `Approved ${approved.length}/${allTriples.length}`);
  await emitTriples(runId, supervisorName, approved);

  return approved;
}

async function supervisorReview(branch: BranchPlan, triples: Triple[]): Promise<Triple[]> {
  if (triples.length === 0) return [];
  if (triples.length <= 4) return triples;
  if (config.stubMode) {
    console.log(`  [supervisor:${branch.id}] stub review — approving all ${triples.length}`);
    return triples;
  }

  const response = await client.messages.create({
    model: config.supervisorModel,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Branch: "${branch.label}" — ${branch.focus}\n\n${JSON.stringify(triples)}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const output = JSON.parse(text) as SupervisorOutput;

  output.rejected.forEach(r =>
    console.log(`  [supervisor:${branch.id}] rejected: ${r.triple.subject.id}->${r.triple.object.id} — ${r.reason}`)
  );

  return output.approved;
}
