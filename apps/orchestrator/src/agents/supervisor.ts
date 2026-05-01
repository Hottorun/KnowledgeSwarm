import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import type { BranchPlan, DocumentChunk, Triple, SupervisorOutput } from '../types';
import { emitAgentEvent } from '../tools/emit';
import { runWorker } from './worker';
import type { SpecialistProfile } from './specialists';
import { specialistDisplayName } from './specialists';
import { parseJsonArrayPropertyItems, parseJsonObject } from './json';

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
  chunks: DocumentChunk[],
  specialist: SpecialistProfile,
  documentName: string
): Promise<Triple[]> {
  const specialistName = specialistDisplayName(specialist, branch);
  const supervisorName = `Supervisor:${specialistName}`;

  await emitAgentEvent(runId, specialistName, 'specialist.selected', specialist.extractionHint, {
    branchId: branch.id,
    branchLabel: branch.label,
    specialist: specialist.kind,
    preferredPredicates: specialist.preferredPredicates,
  });
  await emitAgentEvent(runId, supervisorName, 'started', `Branch: ${branch.label} - ${chunks.length} chunk(s)`);

  const workerResults = await Promise.all(
    chunks.map(async chunk => {
      const workerName = `${specialistName}:Chunk${chunk.index}`;
      await emitAgentEvent(runId, workerName, 'extracting', `Chunk ${chunk.index} (${chunk.text.length} chars)`);
      try {
        const output = await runWorker(chunk, branch.nodeTypes, specialist, branch, documentName);
        await emitAgentEvent(runId, workerName, 'done', `${output.triples.length} triple(s) from chunk ${chunk.index}`);
        return output.triples;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Worker failed';
        console.error(`[${workerName}] ${message}`);
        await emitAgentEvent(runId, workerName, 'failed', message.slice(0, 500));
        return [];
      }
    })
  );

  const allTriples = workerResults.flat();
  await emitAgentEvent(runId, supervisorName, 'reviewing', `Reviewing ${allTriples.length} raw triple(s)`);

  let approved: Triple[];
  try {
    approved = await supervisorReview(branch, specialist, allTriples);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supervisor review failed';
    console.error(`[${supervisorName}] ${message}`);
    await emitAgentEvent(runId, supervisorName, 'warning', `Review failed; using ${allTriples.length} extracted triple(s)`);
    approved = allTriples;
  }

  await emitAgentEvent(runId, supervisorName, 'done', `Approved ${approved.length}/${allTriples.length}`);

  return approved;
}

async function supervisorReview(branch: BranchPlan, specialist: SpecialistProfile, triples: Triple[]): Promise<Triple[]> {
  if (triples.length === 0) return [];
  if (triples.length <= 4) return triples;
  if (config.stubMode) {
    console.log(`  [supervisor:${branch.id}] stub review - approving all ${triples.length}`);
    return triples;
  }

  const response = await client.messages.create({
    model: config.supervisorModel,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Specialist: ${specialist.agentName}
Specialist focus: ${specialist.extractionHint}
Branch: "${branch.label}" - ${branch.focus}

${JSON.stringify(triples)}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const output = parseSupervisorOutput(text);

  output.rejected?.forEach(r =>
    console.log(`  [supervisor:${branch.id}] rejected: ${r.triple.subject.id}->${r.triple.object.id} - ${r.reason}`)
  );

  return output.approved;
}

function parseSupervisorOutput(text: string): SupervisorOutput {
  try {
    const output = parseJsonObject<SupervisorOutput>(text);
    return {
      approved: output.approved ?? [],
      rejected: output.rejected ?? [],
    };
  } catch (error) {
    const approved = parseJsonArrayPropertyItems(text, 'approved') as Triple[];
    if (approved.length > 0) {
      console.warn(`[supervisor] repaired malformed JSON output; salvaged ${approved.length} approved triple(s)`);
      return { approved, rejected: [] };
    }

    throw error;
  }
}
