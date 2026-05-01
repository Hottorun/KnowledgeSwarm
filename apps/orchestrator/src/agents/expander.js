"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandNode = expandNode;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const search_1 = require("../tools/search");
const emit_1 = require("../tools/emit");
const fixtures_1 = require("../stubs/fixtures");
const client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
const SYSTEM_PROMPT = `You are a knowledge expansion agent. Given a graph node and related context, extract new knowledge triples that deepen understanding of that node.

Output ONLY valid JSON — no markdown:
{"triples":[{"subject":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"predicate":"verb_phrase","object":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"confidence":0.0,"sources":[{"url":"","title":"","snippet":""}],"properties":{}}]}

Rules:
- All triples must involve the focus node as subject OR object
- Only state facts supported by the provided context
- Confidence: 0.9+ explicit | 0.7–0.9 implication | discard below 0.6
- Keep JSON compact`;
async function expandNode(req) {
    const { runId, nodeId, nodeLabel, nodeType, context } = req;
    const agentName = `Expander:${nodeId}`;
    await (0, emit_1.emitAgentEvent)(runId, agentName, 'expanding', `Expanding node: ${nodeLabel} (${nodeType})`);
    // Search for external context about this node
    const searchQuery = context
        ? `${nodeLabel} ${context}`
        : `${nodeLabel} ${nodeType}`;
    const results = await (0, search_1.search)(searchQuery);
    if (results.length === 0) {
        await (0, emit_1.emitAgentEvent)(runId, agentName, 'done', 'No results found for expansion');
        return [];
    }
    if (config_1.config.stubMode) {
        const stubExpanded = fixtures_1.STUB_TRIPLES.map(t => ({
            ...t,
            subject: t.subject.id === nodeId ? t.subject : { ...t.subject, id: nodeId, label: nodeLabel, type: nodeType },
        }));
        await (0, emit_1.emitAgentEvent)(runId, agentName, 'done', `stub: ${stubExpanded.length} new triple(s)`);
        await (0, emit_1.emitTriples)(runId, agentName, stubExpanded);
        return stubExpanded;
    }
    const contextText = results
        .map(r => `SOURCE: ${r.url}\n${r.title}\n${r.snippet}${r.content ? '\n' + r.content : ''}`)
        .join('\n\n---\n\n');
    const userMessage = `Focus node: ${nodeLabel} (type: ${nodeType}, id: ${nodeId})\n\nContext:\n${contextText}`;
    const response = await client.messages.create({
        model: config_1.config.expanderModel,
        max_tokens: 2048,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
    });
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const { triples } = JSON.parse(text);
    await (0, emit_1.emitAgentEvent)(runId, agentName, 'done', `${triples.length} new triple(s) added`);
    await (0, emit_1.emitTriples)(runId, agentName, triples);
    return triples;
}
//# sourceMappingURL=expander.js.map