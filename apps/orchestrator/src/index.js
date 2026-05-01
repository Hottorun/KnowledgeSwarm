"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandNode = void 0;
exports.orchestrate = orchestrate;
const config_1 = require("./config");
const meta_1 = require("./agents/meta");
const supervisor_1 = require("./agents/supervisor");
const specialists_1 = require("./agents/specialists");
const emit_1 = require("./tools/emit");
const normalizer_1 = require("./ingest/normalizer");
const chunker_1 = require("./ingest/chunker");
var expander_1 = require("./agents/expander");
Object.defineProperty(exports, "expandNode", { enumerable: true, get: function () { return expander_1.expandNode; } });
async function orchestrate(runId, documentText, documentName = 'input', callbacks) {
    if (callbacks) {
        (0, emit_1.setEmitCallbacks)(callbacks);
    }
    console.log(`\n[orchestrator] run=${runId} stub=${config_1.config.stubMode}`);
    await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'chunking', `Splitting ${documentName} into chunks`);
    const chunks = (0, chunker_1.chunkText)(documentText);
    console.log(`[ingest] ${chunks.length} chunk(s)`);
    const summary = (0, chunker_1.buildDocumentSummary)(documentText, config_1.config.metaSummaryChars);
    await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'decomposing', 'Analyzing document structure');
    const { documentType, branches } = await (0, meta_1.decomposeDocument)(summary);
    console.log(`[meta] documentType=${documentType}, ${branches.length} branch(es):`);
    branches.forEach(b => console.log(`  - ${b.id}: ${b.label}`));
    const specialists = branches.map(specialists_1.specialistForBranch);
    specialists.forEach((specialist, i) => console.log(`  -> ${branches[i].id}: ${specialist.agentName} (${specialist.kind})`));
    const branchChunks = chunks.length <= branches.length
        ? branches.map(() => chunks)
        : branches.map(() => []);
    if (chunks.length > branches.length) {
        chunks.forEach((chunk, i) => branchChunks[i % branches.length].push(chunk));
    }
    await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'dispatching', `${branches.length} specialists in parallel`, {
        documentType,
        specialists: specialists.map((specialist, i) => ({
            branchId: branches[i].id,
            branchLabel: branches[i].label,
            agentName: specialist.agentName,
            kind: specialist.kind,
        })),
    });
    // Track already-emitted triple keys to avoid duplicates across branches
    const emittedKeys = new Set();
    let totalNormalized = 0;
    // Process branches as they complete (not all at once)
    const branchPromises = branches.map((branch, i) => (0, supervisor_1.runSupervisor)(runId, branch, branchChunks[i], specialists[i], documentName)
        .then(triples => ({ status: 'fulfilled', value: triples, branch, i }))
        .catch(error => ({ status: 'rejected', reason: error, branch, i })));
    // Poll for completed branches and emit incrementally
    const pending = new Set(branchPromises);
    while (pending.size > 0) {
        const result = await Promise.race(pending);
        pending.delete(result);
        if (result.status === 'fulfilled') {
            const { value: triples, branch } = result;
            console.log(`[orchestrator] branch "${branch.id}" completed with ${triples.length} triples`);
            if (triples.length > 0) {
                await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'normalizing', `Deduplicating branch "${branch.label}"`);
                const newTriples = (0, normalizer_1.normalizeAndDeduplicate)(triples, emittedKeys);
                console.log(`[orchestrator] branch "${branch.id}": ${triples.length} raw → ${newTriples.length} new triples`);
                if (newTriples.length > 0) {
                    await (0, emit_1.emitTriples)(runId, 'MetaAgent', newTriples);
                    totalNormalized += newTriples.length;
                }
            }
        }
        else {
            console.error(`[orchestrator] branch "${result.branch.id}" failed:`, result.reason);
        }
    }
    console.log(`[orchestrator] total normalized triples: ${totalNormalized}`);
    if (totalNormalized === 0) {
        await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'failed', 'Swarm extracted 0 triples; falling back to generic extraction');
        throw new Error('Swarm extracted 0 triples');
    }
    await (0, emit_1.emitAgentEvent)(runId, 'MetaAgent', 'completed', `Done. ${totalNormalized} triples in graph`);
}
async function main() {
    const { STUB_DOCUMENT_TEXT } = await Promise.resolve().then(() => __importStar(require('./stubs/fixtures')));
    const args = process.argv.slice(2);
    const flags = {};
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                flags[key] = args[++i];
            }
            else {
                flags[key] = 'true';
            }
        }
        else {
            positional.push(args[i]);
        }
    }
    const cliRunId = flags['run-id'];
    const useStdin = flags['stdin'] === 'true';
    const documentName = flags['document-name'] || 'input';
    let documentText;
    if (useStdin) {
        documentText = await readStdin();
    }
    else if (positional.length > 0) {
        documentText = positional[0];
    }
    else {
        documentText = STUB_DOCUMENT_TEXT;
    }
    let runId;
    if (config_1.config.stubMode) {
        runId = `stub-run-${Date.now()}`;
        console.log(`[stub] runId: ${runId}`);
    }
    else if (cliRunId) {
        runId = cliRunId;
        console.log(`[api] using provided runId: ${runId}`);
    }
    else {
        const res = await fetch(`${config_1.config.apiBaseUrl}/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: documentText.slice(0, 200) }),
        });
        if (!res.ok) {
            console.error(`Failed to create run: ${res.status}. Is the API running at ${config_1.config.apiBaseUrl}?`);
            process.exit(1);
        }
        const data = (await res.json());
        runId = data.runId;
        console.log(`[api] created run: ${runId}`);
    }
    await orchestrate(runId, documentText, documentName);
}
function readStdin() {
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
//# sourceMappingURL=index.js.map