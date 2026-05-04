import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { parseJsonObject } from './json';
import { withAnthropicLimit } from './anthropicLimiter';
import { emitAgentEvent } from '../tools/emit';
import type { GraphNode } from '../types';

export interface SubCategoryAssignment {
  name: string;
  memberIds: string[];
}

interface MemberInput {
  id: string;
  label: string;
  type: string;
}

const SYSTEM_PROMPT = `You group a flat list of business entities into 3–7 named sub-categories.

Output ONLY valid JSON — no markdown, no explanation:
{
  "subcategories": [
    { "name": "Short Title Case Name", "memberIds": ["entity-id-1", "entity-id-2"] }
  ]
}

Rules:
- Group by topical theme within the parent category — NOT by entity type alone
- Each input id MUST be assigned to exactly one subcategory; do not drop any id
- 3 to 7 subcategories total. Fewer is better when groups are clear.
- Subcategory names: 1–4 words, Title Case, no parent-category prefix, no "Other"/"Misc" unless truly residual
- Prefer concrete, business-meaningful groupings (Revenue, Costs, Acquisitions, Org Chart, etc.) over vague ones (Things, Items, Data)
- Keep JSON compact`;

export async function subCategorize(
  runId: string,
  parentCategoryLabel: string,
  members: MemberInput[],
): Promise<SubCategoryAssignment[]> {
  if (members.length === 0) return [];

  await emitAgentEvent(
    runId,
    'SubCategorizerAgent',
    'subcategorizer.start',
    `Sub-categorizing ${members.length} ${parentCategoryLabel} entities`,
  );

  if (config.stubMode) {
    return heuristicGroup(members);
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const userMessage = [
    `Parent category: ${parentCategoryLabel}`,
    `Members (${members.length}):`,
    members.map(m => `  - id: ${m.id}, label: ${m.label}, type: ${m.type}`).join('\n'),
  ].join('\n');

  let assignments: SubCategoryAssignment[];
  try {
    const response = await withAnthropicLimit(() => client.messages.create({
      model: config.supervisorModel,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }));
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const parsed = parseJsonObject<{ subcategories?: Array<{ name?: string; memberIds?: string[] }> }>(text);
    assignments = normalizeAssignments(parsed?.subcategories ?? [], members);
  } catch (error) {
    console.error('[subCategorizer] model call failed; falling back to heuristic:', error);
    assignments = heuristicGroup(members);
  }

  await emitAgentEvent(
    runId,
    'SubCategorizerAgent',
    'subcategorizer.grouped',
    `${parentCategoryLabel} → ${assignments.length} subcategories: ${assignments.map(a => `${a.name} (${a.memberIds.length})`).join(', ')}`,
  );

  return assignments;
}

function normalizeAssignments(
  raw: Array<{ name?: string; memberIds?: string[] }>,
  members: MemberInput[],
): SubCategoryAssignment[] {
  const knownIds = new Set(members.map(m => m.id));
  const assigned = new Set<string>();
  const out: SubCategoryAssignment[] = [];

  for (const entry of raw) {
    const name = (entry?.name ?? '').trim();
    const ids = (entry?.memberIds ?? [])
      .filter((id): id is string => typeof id === 'string')
      .filter(id => knownIds.has(id) && !assigned.has(id));
    if (!name || ids.length === 0) continue;
    for (const id of ids) assigned.add(id);
    out.push({ name, memberIds: ids });
  }

  // Anything the model missed gets bundled into "Other".
  const remaining = members.filter(m => !assigned.has(m.id)).map(m => m.id);
  if (remaining.length > 0) {
    out.push({ name: 'Other', memberIds: remaining });
  }

  return out;
}

// Lightweight fallback for stub mode and model failures: group by entity
// type. Keeps the tree balanced even without an AI call.
function heuristicGroup(members: MemberInput[]): SubCategoryAssignment[] {
  const byType = new Map<string, string[]>();
  for (const m of members) {
    const bucket = (m.type || 'Entity').replace(/[_-]+/g, ' ').trim() || 'Entity';
    const list = byType.get(bucket) ?? [];
    list.push(m.id);
    byType.set(bucket, list);
  }
  return [...byType.entries()].map(([name, memberIds]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    memberIds,
  }));
}

export function memberInputFromNode(node: GraphNode): MemberInput {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
  };
}
