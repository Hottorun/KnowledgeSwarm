"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSupervisor = runSupervisor;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const emit_1 = require("../tools/emit");
const worker_1 = require("./worker");
const specialists_1 = require("./specialists");
const json_1 = require("./json");
const client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
const SYSTEM_PROMPT = `You are a research supervisor. Review extracted knowledge triples and filter for quality.

Output ONLY valid JSON — no markdown, no explanation:
{"approved":[...triples...],"rejected":[{"triple":{...},"reason":"short reason"}]}

Reject triples that:
- Have vague predicates like "is", "has", "exists"
- Have non-specific node IDs like "entity:unknown"
- Are obvious duplicates of another triple in the list
- Have no supporting source snippet`;
async function runSupervisor(runId, branch, chunks, specialist, documentName) {
    const specialistName = (0, specialists_1.specialistDisplayName)(specialist, branch);
    const supervisorName = `Supervisor:${specialistName}`;
    await (0, emit_1.emitAgentEvent)(runId, specialistName, 'specialist.selected', specialist.extractionHint, {
        branchId: branch.id,
        branchLabel: branch.label,
        specialist: specialist.kind,
        preferredPredicates: specialist.preferredPredicates,
    });
    await (0, emit_1.emitAgentEvent)(runId, supervisorName, 'started', `Branch: ${branch.label} - ${chunks.length} chunk(s)`);
    const workerResults = await Promise.all(chunks.map(async (chunk) => {
        const workerName = `${specialistName}:Chunk${chunk.index}`;
        await (0, emit_1.emitAgentEvent)(runId, workerName, 'extracting', `Chunk ${chunk.index} (${chunk.text.length} chars)`);
        try {
            const output = await (0, worker_1.runWorker)(chunk, branch.nodeTypes, specialist, branch, documentName);
            await (0, emit_1.emitAgentEvent)(runId, workerName, 'done', `${output.triples.length} triple(s) from chunk ${chunk.index}`);
            return output.triples;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Worker failed';
            console.error(`[${workerName}] ${message}`);
            await (0, emit_1.emitAgentEvent)(runId, workerName, 'failed', message.slice(0, 500));
            return [];
        }
    }));
    const allTriples = workerResults.flat();
    await (0, emit_1.emitAgentEvent)(runId, supervisorName, 'reviewing', `Reviewing ${allTriples.length} raw triple(s)`);
    let approved;
    try {
        approved = await supervisorReview(branch, specialist, allTriples);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Supervisor review failed';
        console.error(`[${supervisorName}] ${message}`);
        await (0, emit_1.emitAgentEvent)(runId, supervisorName, 'warning', `Review failed; using ${allTriples.length} extracted triple(s)`);
        approved = allTriples;
    }
    await (0, emit_1.emitAgentEvent)(runId, supervisorName, 'done', `Approved ${approved.length}/${allTriples.length}`);
    return approved;
}
async function supervisorReview(branch, specialist, triples) {
    if (triples.length === 0)
        return [];
    if (triples.length <= 4)
        return triples;
    if (config_1.config.stubMode) {
        console.log(`  [supervisor:${branch.id}] stub review - approving all ${triples.length}`);
        return triples;
    }
    const response = await client.messages.create({
        model: config_1.config.supervisorModel,
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
    const output = (0, json_1.parseJsonObject)(text);
    output.rejected.forEach(r => console.log(`  [supervisor:${branch.id}] rejected: ${r.triple.subject.id}->${r.triple.object.id} - ${r.reason}`));
    return output.approved;
}
//# sourceMappingURL=supervisor.js.map