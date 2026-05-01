"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setEmitCallbacks = setEmitCallbacks;
exports.emitAgentEvent = emitAgentEvent;
exports.emitTriples = emitTriples;
const config_1 = require("../config");
let _callbacks = {};
function setEmitCallbacks(cb) {
    _callbacks = cb;
}
async function emitAgentEvent(runId, agentName, eventType, message, payload = {}) {
    if (config_1.config.stubMode) {
        console.log(`  [${agentName}] ${eventType}: ${message}`);
        return;
    }
    if (_callbacks.emitAgentEvent) {
        return _callbacks.emitAgentEvent(runId, agentName, eventType, message, payload);
    }
    const res = await fetch(`${config_1.config.apiBaseUrl}/runs/${runId}/agent-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName, eventType, message, payload }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[emit] agent-events failed: ${res.status} ${body}`);
    }
}
async function emitTriples(runId, agentName, triples) {
    if (triples.length === 0)
        return;
    if (config_1.config.stubMode) {
        console.log(`  [${agentName}] pushing ${triples.length} triple(s):`);
        triples.forEach(t => console.log(`    ${t.subject.label} -[${t.predicate}]-> ${t.object.label} (conf: ${t.confidence ?? '?'})`));
        return;
    }
    if (_callbacks.emitTriples) {
        return _callbacks.emitTriples(runId, agentName, triples);
    }
    const res = await fetch(`${config_1.config.apiBaseUrl}/runs/${runId}/triples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName, triples }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[emit] triples failed: ${res.status} ${body}`);
    }
}
//# sourceMappingURL=emit.js.map