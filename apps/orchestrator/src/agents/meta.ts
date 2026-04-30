import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { STUB_DECOMPOSITION } from '../stubs/fixtures';
import type { DecompositionResult } from '../types';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

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

export async function decomposeDocument(documentSummary: string): Promise<DecompositionResult> {
  if (config.stubMode) {
    console.log('[meta] stub decomposition');
    return STUB_DECOMPOSITION;
  }

  const response = await client.messages.create({
    model: config.metaModel,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Document excerpt:\n\n${documentSummary}` }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  return JSON.parse(text) as DecompositionResult;
}
