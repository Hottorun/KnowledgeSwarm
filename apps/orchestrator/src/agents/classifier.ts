import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { parseJsonObject } from './json';
import { withAnthropicLimit } from './anthropicLimiter';
import { emitAgentEvent } from '../tools/emit';
import { CATEGORY_KEYS, type CategoryKey } from '../ingest/categories';

export interface DocumentClassification {
  documentName: string;
  primaryCategory: CategoryKey;
  secondaryCategories: CategoryKey[];
  reason: string;
  confidence: number;
  source: 'model' | 'heuristic';
}

const SYSTEM_PROMPT = `You classify a document into a primary business category and up to two secondary categories.

Output ONLY valid JSON — no markdown, no explanation:
{
  "primaryCategory": "finance|hr-people|legal|operations|strategy-market|technology|risk|other",
  "secondaryCategories": ["finance|hr-people|legal|operations|strategy-market|technology|risk|other"],
  "reason": "One sentence: what content drove the choice",
  "confidence": 0.0
}

Rules:
- primaryCategory MUST be one of the listed keys (lowercased, hyphenated where shown)
- secondaryCategories: 0 to 2 keys, distinct from primaryCategory
- confidence: 0.0 to 1.0; lower when the document mixes categories evenly
- "other" is a last resort — only when no listed category fits at all
- Keep JSON compact`;

export async function classifyDocument(
  runId: string,
  documentName: string,
  documentSummary: string,
): Promise<DocumentClassification> {
  await emitAgentEvent(
    runId,
    'DocumentClassifierAgent',
    'classifier.start',
    `Classifying ${documentName}`,
  );

  if (config.stubMode) {
    const fallback = heuristicClassify(documentName, documentSummary);
    await emitAgentEvent(
      runId,
      'DocumentClassifierAgent',
      'classifier.classified',
      `${documentName} → ${fallback.primaryCategory} (stub)`,
      classificationPayload(fallback),
    );
    return fallback;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  let classification: DocumentClassification;
  try {
    const response = await withAnthropicLimit(() => client.messages.create({
      model: config.supervisorModel,
      max_tokens: 256,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Document name: ${documentName}\n\nExcerpt:\n${documentSummary}`,
      }],
    }));
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const parsed = parseJsonObject<{
      primaryCategory?: string;
      secondaryCategories?: string[];
      reason?: string;
      confidence?: number;
    }>(text);
    classification = normalizeClassification(documentName, parsed);
  } catch (error) {
    console.error('[classifier] model call failed; falling back to heuristic:', error);
    classification = heuristicClassify(documentName, documentSummary);
  }

  await emitAgentEvent(
    runId,
    'DocumentClassifierAgent',
    'classifier.classified',
    `${documentName} → ${classification.primaryCategory}${
      classification.secondaryCategories.length > 0
        ? ` (also: ${classification.secondaryCategories.join(', ')})`
        : ''
    } — ${classification.reason}`,
    classificationPayload(classification),
  );

  return classification;
}

function classificationPayload(classification: DocumentClassification) {
  return {
    documentName: classification.documentName,
    primaryCategory: classification.primaryCategory,
    secondaryCategories: classification.secondaryCategories,
    confidence: classification.confidence,
    source: classification.source,
  };
}

function normalizeClassification(
  documentName: string,
  parsed: { primaryCategory?: string; secondaryCategories?: string[]; reason?: string; confidence?: number },
): DocumentClassification {
  const primary = coerceCategory(parsed.primaryCategory) ?? 'other';
  const secondaries: CategoryKey[] = [];
  for (const candidate of parsed.secondaryCategories ?? []) {
    const coerced = coerceCategory(candidate);
    if (coerced && coerced !== primary && !secondaries.includes(coerced)) {
      secondaries.push(coerced);
      if (secondaries.length >= 2) break;
    }
  }
  const confidence = clamp(parsed.confidence ?? 0.7, 0, 1);
  const reason = (parsed.reason ?? '').trim() || 'Model classification';

  return {
    documentName,
    primaryCategory: primary,
    secondaryCategories: secondaries,
    reason,
    confidence: Number(confidence.toFixed(2)),
    source: 'model',
  };
}

function coerceCategory(raw: string | undefined): CategoryKey | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if ((CATEGORY_KEYS as readonly string[]).includes(normalized)) {
    return normalized as CategoryKey;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Deterministic fallback — used in stub mode and when the model call fails.
// Mirrors the keyword sets in the presentation builder so we never produce a
// category outside the supported enum.
const HEURISTIC_KEYWORDS: Array<{ key: CategoryKey; keywords: string[] }> = [
  { key: 'finance', keywords: ['finance', 'financial', 'revenue', 'cost', 'margin', 'valuation', 'investor', 'funding', 'payment', 'fee', 'debt', 'profit', 'budget', 'acquisition'] },
  { key: 'hr-people', keywords: ['employee', 'team', 'role', 'hr', 'salary', 'compensation', 'manager', 'leadership', 'responsibility', 'staff', 'headcount'] },
  { key: 'legal', keywords: ['legal', 'contract', 'agreement', 'patent', 'license', 'compliance', 'regulation', 'jurisdiction', 'obligation', 'confidentiality', 'termination'] },
  { key: 'operations', keywords: ['operation', 'warehouse', 'order', 'shipment', 'logistics', 'inventory', 'supplier', 'supply', 'facility', 'manufacturing', 'delivery', 'vendor'] },
  { key: 'strategy-market', keywords: ['market', 'customer', 'competitor', 'partner', 'partnership', 'industry', 'geography', 'growth', 'positioning', 'commercial', 'sales'] },
  { key: 'technology', keywords: ['technology', 'technical', 'system', 'software', 'api', 'database', 'security', 'product', 'platform', 'integration', 'infrastructure'] },
  { key: 'risk', keywords: ['risk', 'exposure', 'threat', 'dependency', 'liability', 'constraint', 'failure', 'mitigation', 'vulnerability'] },
];

export function heuristicClassify(documentName: string, documentSummary: string): DocumentClassification {
  const text = `${documentName} ${documentSummary}`.toLowerCase();
  const counts = new Map<CategoryKey, number>();
  for (const { key, keywords } of HEURISTIC_KEYWORDS) {
    let hits = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) hits++;
    }
    if (hits > 0) counts.set(key, hits);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = ranked[0]?.[0] ?? 'other';
  const secondaries = ranked.slice(1, 3).map(([key]) => key);
  const totalHits = ranked.reduce((sum, [, count]) => sum + count, 0);
  const leadHits = ranked[0]?.[1] ?? 0;
  const confidence = totalHits === 0
    ? 0.4
    : Math.max(0.5, Math.min(0.9, 0.5 + (leadHits / totalHits) * 0.4));

  return {
    documentName,
    primaryCategory: primary,
    secondaryCategories: secondaries,
    reason: ranked.length > 0
      ? `Keyword scan: ${ranked.slice(0, 3).map(([key, count]) => `${key}(${count})`).join(', ')}`
      : 'No category keywords matched; defaulting to other',
    confidence: Number(confidence.toFixed(2)),
    source: 'heuristic',
  };
}
