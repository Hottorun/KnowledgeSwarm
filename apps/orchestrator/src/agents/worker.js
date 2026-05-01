"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWorker = runWorker;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const fixtures_1 = require("../stubs/fixtures");
const json_1 = require("./json");
const client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
const SYSTEM_PROMPT = `You are a knowledge extraction worker. Extract Subject-Predicate-Object triples from a document chunk.

Output ONLY valid JSON — no markdown, no explanation:
{"triples":[{"subject":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"predicate":"verb_phrase","object":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"confidence":0.0,"sources":[{"url":"document","title":"Document","snippet":"exact quote"}],"properties":{}}]}

Rules:
- Node ID format: type:slug (e.g. company:acme-corp, person:jane-doe, obligation:monthly-payment)
- Extract ONLY facts explicitly stated in the text — never hallucinate
- Extract at least 3 concrete triples when the chunk contains explicit relationships
- Confidence: 0.9+ explicit | 0.7–0.9 strong implication | 0.5–0.7 inference — discard below 0.5
- Use the exact quoted text as the source snippet
- Keep JSON compact`;
async function runWorker(chunk, focusNodeTypes, specialist, branch, documentName) {
    if (config_1.config.stubMode) {
        console.log(`  [${specialist.agentName}] stub - chunk ${chunk.index}`);
        return { triples: withProvenance(fixtures_1.STUB_TRIPLES, specialist, branch, chunk.index, documentName) };
    }
    const userMessage = `Specialist: ${specialist.agentName}
Extraction focus: ${specialist.extractionHint}
Preferred predicates: ${specialist.preferredPredicates.join(', ')}
Focus entity types: ${[...new Set([...focusNodeTypes, ...specialist.nodeTypes])].join(', ')}
Branch: ${branch.label} - ${branch.focus}
Source document: ${documentName}

Document chunk ${chunk.index}:

${chunk.text}`;
    const response = await client.messages.create({
        model: config_1.config.workerModel,
        max_tokens: 2048,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
    });
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const output = (0, json_1.parseJsonObject)(text);
    return {
        triples: withProvenance(normalizeWorkerTriples(output.triples ?? []), specialist, branch, chunk.index, documentName),
    };
}
function normalizeWorkerTriples(triples) {
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
function makeId(type, label) {
    return `${type.toLowerCase()}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}
function withProvenance(triples, specialist, branch, chunkIndex, documentName) {
    return triples.map(triple => ({
        ...triple,
        properties: {
            ...(triple.properties ?? {}),
            specialist: specialist.kind,
            branchId: branch.id,
            chunkIndex,
            documentName,
        },
    }));
}
//# sourceMappingURL=worker.js.map