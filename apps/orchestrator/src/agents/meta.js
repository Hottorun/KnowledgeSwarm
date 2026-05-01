"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decomposeDocument = decomposeDocument;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const fixtures_1 = require("../stubs/fixtures");
const json_1 = require("./json");
const client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
const SYSTEM_PROMPT = `You are a document analysis meta-agent. Read a document excerpt and decompose it into independent analysis branches.

Output ONLY valid JSON — no markdown, no explanation:
{
  "documentType": "contract|report|policy|filing|other",
  "branches": [
    {
      "id": "snake_case_id",
      "label": "Human-readable branch name",
      "focus": "One sentence: what concepts this branch extracts",
      "nodeTypes": ["EntityType1", "EntityType2"]
    }
  ]
}

Rules:
- 3 to 5 branches maximum
- Branches must be INDEPENDENT (different conceptual areas, not every node needs to connect)
- Node types: Company, Person, Market, Product, Financial, Risk, Regulation, Technology, Obligation, Date, Location, Role
- Base branches on the document's actual content, not generic categories
- Keep JSON compact`;
async function decomposeDocument(documentSummary) {
    if (config_1.config.stubMode) {
        console.log('[meta] stub decomposition');
        return fixtures_1.STUB_DECOMPOSITION;
    }
    const response = await client.messages.create({
        model: config_1.config.metaModel,
        max_tokens: 1024,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Document excerpt:\n\n${documentSummary}` }],
    });
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return (0, json_1.parseJsonObject)(text);
}
//# sourceMappingURL=meta.js.map