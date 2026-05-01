import { RawExtractedTriple } from './ingestion';
import { SearchResult, performSearch } from './search';
import { config } from '../config';

// Runtime key takes precedence over env so the user can set it via the API
let runtimeOpenAIKey: string | null = null;

export function setRuntimeOpenAIKey(key: string): void {
  runtimeOpenAIKey = key;
}

export function getOpenAIKey(): string | null {
  return runtimeOpenAIKey || config.openaiApiKey || null;
}

export function isOpenAIConfigured(): boolean {
  return !!getOpenAIKey();
}

// Validate key format without making a real API call
export function validateKeyFormat(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callOpenAI(
  messages: OpenAIMessage[],
  opts: { model?: string; temperature?: number; jsonMode?: boolean } = {}
): Promise<string> {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const model = opts.model || 'gpt-4o-mini';
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.1,
  };
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

const EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine.
Given a text chunk, extract ALL meaningful Subject-Predicate-Object relationships.

LABEL QUALITY — STRICT:
- Labels must be specific, human-readable, and descriptive — never snake_case or generic category words.
- BAD: "sales_decline", "revenue_figure", "key_person", "market_share"
- GOOD: "Revenue: $89.5B (Q1 2024)", "Tim Cook", "iPhone 15 Pro", "Global market share: 35%"
- For data points, include the actual number or fact in the label (max 60 chars).

QUANTITATIVE DATA — NON-NEGOTIABLE:
- If exact numbers are present in the text, copy them VERBATIM into the label and into exact_value/unit fields. NEVER round, truncate, or summarize a number.
- If a number is ambiguous or missing, set exact_value to null and unit to null. Do NOT guess.
- exact_value: the raw numeric value as a number (e.g. 89.5, not "89.5B"). Billions/millions belong in unit.
- unit: the measurement denomination (e.g. "billion USD", "million EUR", "%", "employees", "years").
- A label of "Revenue: ~$90B" when the source says "$89.5B" is a VIOLATION — output "$89.5B" exactly.

Rules:
- Subject and Object must be named entities (companies, people, products, markets, locations) OR specific descriptive data points.
- Predicate must be a short verb phrase (1-4 words, e.g. "acquired", "founded by", "reported", "competes with").
- subjectType and objectType must be one of: Company, Person, Market, Product, Document, Location, Concept, Entity.
- confidence is 0.0–1.0 based on how explicit the relationship is in the text.
- Omit trivial, vague, or duplicate relationships.

Output ONLY valid JSON:
{
  "triples": [{
    "subject": string,
    "predicate": string,
    "object": string,
    "subjectType": string,
    "objectType": string,
    "confidence": number,
    "exact_value": number | null,
    "unit": string | null
  }]
}`;

export interface ExtractionResult {
  triples: RawExtractedTriple[];
  chunkIndex: number;
  error?: string;
}

export async function extractTriplesFromChunk(
  chunkText: string,
  chunkIndex: number,
  documentName?: string
): Promise<ExtractionResult> {
  try {
    const raw = await callOpenAI(
      [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user', content: `Document: ${documentName || 'unknown'}\n\nText:\n${chunkText}` },
      ],
      { jsonMode: true, temperature: 0 }
    );

    const parsed = JSON.parse(raw) as { triples?: Array<Record<string, unknown>> };
    const triples: RawExtractedTriple[] = (parsed.triples || [])
      .filter(t => t.subject && t.predicate && t.object)
      .map(t => {
        const exactValue = typeof t.exact_value === 'number' ? t.exact_value : null;
        const unit = typeof t.unit === 'string' && t.unit ? t.unit : null;
        // If structured numeric fields are present, verify the label carries the verbatim
        // value. If the label is missing the raw number, reconstruct it.
        let object = String(t.object);
        if (exactValue !== null && unit !== null) {
          const numStr = String(exactValue);
          if (!object.includes(numStr)) {
            object = `${object}: ${exactValue} ${unit}`.slice(0, 60);
          }
        }
        return {
          subject: String(t.subject),
          predicate: String(t.predicate),
          object,
          subjectType: t.subjectType ? String(t.subjectType) : undefined,
          objectType: t.objectType ? String(t.objectType) : undefined,
          confidence: typeof t.confidence === 'number' ? t.confidence : undefined,
          source: documentName ? { documentName } : undefined,
        };
      });

    return { triples, chunkIndex };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { triples: [], chunkIndex, error: message };
  }
}

export interface SubtreeNode {
  id: string;
  label: string;
  type: string;
}

export interface SubtreeEdge {
  subjectLabel: string;
  predicate: string;
  objectLabel: string;
}

export interface ExpandSubtreeInput {
  rootNode: SubtreeNode;
  nodes: SubtreeNode[];
  edges: SubtreeEdge[];
  question?: string;
  parentNode?: SubtreeNode;
  siblings?: string[];
  graphDepth?: number;
  globalBranches?: string[];
}

export interface ExpandSubtreeResult {
  summary: string;
  newTriples: RawExtractedTriple[];
  searchQueries: string[];
  searchResultCount: number;
}

// Stable lowercase slug — used as temp IDs for items created in Pass 1 so Pass 2 can
// reference them as parent candidates before they have real backend IDs.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

// BFS from rootLabel AND any already-in-graph node labels (they are reachable by
// definition). Drops triples whose both endpoints can't be reached. Safety net
// against orphan nodes even after two-pass routing.
function filterToConnectedTriples(
  triples: RawExtractedTriple[],
  rootLabel: string,
  existingNodeLabels: string[] = [],
): RawExtractedTriple[] {
  if (triples.length === 0) return triples;

  const norm = (s: string) => s.toLowerCase().trim();
  const reachable = new Set<string>([norm(rootLabel), ...existingNodeLabels.map(norm)]);

  let grew = true;
  while (grew) {
    grew = false;
    for (const t of triples) {
      const s = norm(t.subject);
      const o = norm(t.object);
      if (reachable.has(s) && !reachable.has(o)) { reachable.add(o); grew = true; }
      else if (reachable.has(o) && !reachable.has(s)) { reachable.add(s); grew = true; }
    }
  }

  return triples.filter(t => reachable.has(norm(t.subject)) && reachable.has(norm(t.object)));
}

// Internal types for the two-pass extraction architecture
interface ExtractedItem {
  id: string;            // temp ID: "new:<slug>"
  label: string;
  type: string;
  brief: string;
  isCategory: boolean;   // grouping node — must connect to root
  exact_value: number | null;  // verbatim numeric value when item is quantitative
  unit: string | null;         // measurement unit (e.g. "billion USD", "%")
}

interface ItemConnection {
  itemLabel: string;
  parentId: string;
  predicate: string;
  confidence: number;
}

export async function expandSubtree(input: ExpandSubtreeInput): Promise<ExpandSubtreeResult> {
  const { rootNode, nodes, question, parentNode, graphDepth = 0 } = input;

  const lineagePath = parentNode ? `${parentNode.label} → ${rootNode.label}` : rootNode.label;
  const depthLabel =
    graphDepth === 0 ? 'root entity'
    : graphDepth === 1 ? 'Level 1 pillar'
    : graphDepth === 2 ? 'Level 2 subdivision'
    : graphDepth === 3 ? 'Level 3 specific entity/fact'
    : `Level ${graphDepth} deep detail`;

  const userQuestionDriven = !!question?.trim();

  // Step 1: Ask the AI to generate focused web search queries
  const queryGenPrompt = `You are a research planner for a structured knowledge graph.

The user clicked on a node to expand it. Search for information that fits the node's level of abstraction.

TARGET NODE: "${rootNode.label}" (${rootNode.type}) — ${depthLabel}
LINEAGE: ${lineagePath}
${parentNode ? `PARENT: "${parentNode.label}"` : ''}
${question ? `USER QUESTION: ${question}` : ''}

${userQuestionDriven
  ? `The user's question OVERRIDES default abstraction. Search exactly for what the question asks about, scoped to "${rootNode.label}".`
  : graphDepth <= 1
    ? `Level ${graphDepth}: search for the broadest CATEGORIES and PILLARS of "${rootNode.label}" — e.g. "main business divisions of X", "core areas of X". NO statistics, NO leaf facts, NO named individuals.`
    : graphDepth === 2
      ? `Level 2: search for named SUB-DIVISIONS, entities, and key components within "${rootNode.label}".`
      : graphDepth === 3
        ? `Level 3: search for SPECIFIC FACTS, statistics, individual names, products, and data points about "${rootNode.label}".`
        : `Level ${graphDepth}: drill DEEPER into "${rootNode.label}" — micro-facts, granular attributes, dates, exact figures, related sub-properties. Stay scoped to "${rootNode.label}" within its lineage.`}

Generate 2–3 specific, distinct web search queries that target this level.
Output JSON: { "queries": [string, string, ...] }`;

  const queryRaw = await callOpenAI(
    [{ role: 'user', content: queryGenPrompt }],
    { jsonMode: true, temperature: 0.3 }
  );

  const queryParsed = JSON.parse(queryRaw) as { queries?: string[] };
  const searchQueries: string[] = (queryParsed.queries || []).slice(0, 3);

  if (searchQueries.length === 0) {
    // Fallback query if AI didn't generate any
    searchQueries.push(question ? `${rootNode.label} ${question}` : `${rootNode.label} ${rootNode.type} relationships facts`);
  }

  // Step 2: Run all search queries in parallel
  const searchResultsByQuery = await Promise.allSettled(
    searchQueries.map(q => performSearch(q))
  );

  // Collect all results, labelled by query
  const allWebContext: string[] = [];
  const allSearchResults: SearchResult[] = [];

  for (let i = 0; i < searchResultsByQuery.length; i++) {
    const outcome = searchResultsByQuery[i];
    if (outcome.status === 'fulfilled') {
      for (const r of outcome.value.results) {
        allSearchResults.push(r);
        allWebContext.push(`[Q: "${searchQueries[i]}"] ${r.title} — ${r.snippet}`);
      }
    }
  }

  if (allWebContext.length === 0) {
    throw new Error('No web search results returned. Configure TAVILY_API_KEY or BRAVE_SEARCH_API_KEY in .env');
  }

  // ── PASS 1: Pure extraction — LLM only identifies WHAT exists, ignores all graph structure ──

  const depthInstruction = userQuestionDriven
    ? `The user's question takes absolute priority. Extract exactly what it asks about at whatever specificity is required.`
    : graphDepth <= 1
      ? `Level ${graphDepth} — extract BROAD CATEGORIES only. No named individuals, no statistics, no dates, no numbers.
Good: "Financial Performance", "Leadership", "Product Strategy", "Market Position"
Bad (forbidden): "$200B revenue", "Tim Cook", "iPhone 15", any specific name or number.
If you cannot form a broad category, produce FEWER items rather than substituting a leaf fact.`
      : graphDepth === 2
        ? `Level 2 — extract named sub-entities: products, people, departments, markets. Avoid raw statistics.`
        : `Level ${graphDepth}+ — extract ATOMIC FACTS: exact numbers, specific names, concrete dates. Be granular, not generic.`;

  // Detect grouping intent so Pass 1 knows to emit one category item first
  const isGroupingQuestion = !!question?.match(/\b(?:find|list|show|similar|compare|get)\b/i);
  const groupingNote = isGroupingQuestion
    ? `\nGROUPING: The question asks for a list. Emit exactly ONE category node first (isCategory: true, label = the group name like "Similar Companies"), then the individual items (isCategory: false).`
    : '';

  const allExistingLabels = [rootNode.label, ...nodes.map(n => n.label)];

  const pass1System = `You are a pure information extractor. Your ONLY job: read the web research and extract new information items.

STRICT RULES:
- Return a FLAT list of items — no hierarchy, no edges, no parent references, no graph structure
- Do NOT think about how items connect to each other or to existing nodes
- Labels must be specific and human-readable, max 60 characters, no snake_case
- Omit vague or generic items ("some facts", "various companies")
- Type must be one of: Company, Person, Product, Market, Technology, Location, Concept, Entity
- Do NOT duplicate labels from the EXISTING list

QUANTITATIVE DATA — NON-NEGOTIABLE:
- If exact numbers are present in the research, copy them VERBATIM into the label AND into exact_value/unit fields. NEVER round, truncate, or summarize.
- If a number is ambiguous, set exact_value to null and unit to null. Do NOT guess.
- exact_value: the raw numeric portion as a JSON number (e.g. 89.5). Scale factors (billion/million) go into unit.
- unit: the full denomination string (e.g. "billion USD", "million employees", "%", "years").
- A label approximating "$90B" when the source says "$89.5B" is a violation — use "$89.5B" verbatim.

Output JSON:
{
  "summary": "2-3 sentence summary of key findings about the target",
  "items": [{
    "label": string,
    "type": string,
    "brief": string,
    "isCategory": boolean,
    "exact_value": number | null,
    "unit": string | null
  }]
}`;

  const pass1User = `TARGET: "${rootNode.label}" (${rootNode.type}) — ${depthLabel}
LINEAGE: ${lineagePath}
${question ? `QUESTION: ${question}` : `GOAL: Find the key aspects and components of "${rootNode.label}"`}

DEPTH RULE: ${depthInstruction}${groupingNote}

EXISTING LABELS (do NOT duplicate): ${allExistingLabels.join(', ')}

WEB RESEARCH:
${allWebContext.slice(0, 24).join('\n\n')}`;

  const pass1Raw = await callOpenAI(
    [{ role: 'system', content: pass1System }, { role: 'user', content: pass1User }],
    { model: 'gpt-4o-mini', jsonMode: true, temperature: 0 }
  );

  const pass1Parsed = JSON.parse(pass1Raw) as { summary?: string; items?: Array<Record<string, unknown>> };
  const summary = pass1Parsed.summary || `Expanded "${rootNode.label}".`;

  const extractedItems: ExtractedItem[] = (pass1Parsed.items || [])
    .filter(i => i.label && i.type)
    .map(i => {
      const exactValue = typeof i.exact_value === 'number' ? i.exact_value : null;
      const unit = typeof i.unit === 'string' && i.unit ? i.unit : null;
      let label = String(i.label).trim().slice(0, 60);
      // If structured numeric fields are present and the label is missing the verbatim
      // value, reconstruct it so the node accurately reflects the source data.
      if (exactValue !== null && unit !== null && !label.includes(String(exactValue))) {
        label = `${label}: ${exactValue} ${unit}`.slice(0, 60);
      }
      return {
        id: `new:${slugify(label)}`,
        label,
        type: String(i.type || 'Entity'),
        brief: String(i.brief || ''),
        isCategory: Boolean(i.isCategory),
        exact_value: exactValue,
        unit,
      };
    });

  if (extractedItems.length === 0) {
    return { summary, newTriples: [], searchQueries, searchResultCount: allSearchResults.length };
  }

  // ── PASS 2: Routing agent — assigns each extracted item to its correct parent ──
  // Available parents: root node + existing context nodes + new category items from Pass 1.
  // Category items route to root; individual items route to the best semantic match.

  const availableParents = [
    { id: rootNode.id, label: rootNode.label, role: 'ROOT — always available' },
    ...nodes.map(n => ({ id: n.id, label: n.label, role: 'existing' })),
    ...extractedItems
      .filter(i => i.isCategory)
      .map(i => ({ id: i.id, label: i.label, role: 'new category from Pass 1' })),
  ];

  const pass2System = `You are a graph routing agent. Your ONLY job: assign each new item to its correct parent node from the list provided.

STRICT RULES:
- Every item must connect to EXACTLY ONE parent from AVAILABLE PARENTS — no other IDs allowed
- Category items (isCategory: true) MUST connect to the ROOT node ID
- Individual items connect to the most semantically appropriate parent:
  • Prefer new category nodes (from Pass 1) when the item clearly belongs to that group
  • Prefer existing nodes when the item is a known attribute of that entity
  • Fall back to ROOT only if no better parent exists
- Predicates must be specific and meaningful: "includes", "founded_by", "has_ceo", "age", "located_in", "competes_with"
- Never connect an item to itself

Output JSON: { "connections": [{ "itemLabel": string, "parentId": string, "predicate": string, "confidence": number }] }`;

  const pass2User = `ROOT: "${rootNode.label}" (ID: "${rootNode.id}")
${question ? `ORIGINAL QUESTION: ${question}` : ''}

AVAILABLE PARENT NODES:
${JSON.stringify(availableParents, null, 2)}

NEW ITEMS TO CONNECT:
${JSON.stringify(extractedItems.map(i => ({ id: i.id, label: i.label, type: i.type, brief: i.brief, isCategory: i.isCategory })), null, 2)}

Route each item. Category items → ROOT. Individual items → best category or ROOT.`;

  const pass2Raw = await callOpenAI(
    [{ role: 'system', content: pass2System }, { role: 'user', content: pass2User }],
    { model: 'gpt-4o-mini', jsonMode: true, temperature: 0.0 }
  );

  const pass2Parsed = JSON.parse(pass2Raw) as { connections?: Array<Record<string, unknown>> };
  const connections: ItemConnection[] = (pass2Parsed.connections || [])
    .filter(c => c.itemLabel && c.parentId)
    .map(c => ({
      itemLabel: String(c.itemLabel),
      parentId: String(c.parentId),
      predicate: String(c.predicate || 'relates_to'),
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.7,
    }));

  // ── Build triples from routing output ──────────────────────────────────────

  // Map IDs (both backend IDs and temp "new:..." IDs) back to labels and types
  const idToLabel = new Map<string, string>();
  idToLabel.set(rootNode.id, rootNode.label);
  nodes.forEach(n => idToLabel.set(n.id, n.label));
  extractedItems.forEach(i => idToLabel.set(i.id, i.label));

  const labelToType = new Map<string, string>();
  labelToType.set(rootNode.label.toLowerCase(), rootNode.type);
  nodes.forEach(n => labelToType.set(n.label.toLowerCase(), n.type));
  extractedItems.forEach(i => labelToType.set(i.label.toLowerCase(), i.type));

  const rawTriples: RawExtractedTriple[] = connections
    .filter(c => idToLabel.has(c.parentId))
    .map(c => {
      const parentLabel = idToLabel.get(c.parentId)!;
      const item = extractedItems.find(i => i.label === c.itemLabel);
      return {
        subject: parentLabel,
        predicate: c.predicate,
        object: c.itemLabel,
        subjectType: labelToType.get(parentLabel.toLowerCase()) ?? 'Entity',
        objectType: item?.type ?? 'Entity',
        confidence: c.confidence,
      };
    });

  const existingNodeLabels = nodes.map(n => n.label);
  const newTriples = filterToConnectedTriples(rawTriples, rootNode.label, existingNodeLabels);

  return {
    summary,
    newTriples,
    searchQueries,
    searchResultCount: allSearchResults.length,
  };
}

// Verify the key works by calling the models list endpoint (cheap check)
export async function verifyOpenAIKey(key: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface NodeRelationship {
  direction: 'out' | 'in';
  predicate: string;
  otherLabel: string;
}

export async function describeNode(
  label: string,
  entityType: string,
  relationships: NodeRelationship[],
): Promise<string | null> {
  try {
    const relText = relationships.length > 0
      ? relationships
          .slice(0, 8)
          .map(r => r.direction === 'out'
            ? `${label} ${r.predicate} ${r.otherLabel}`
            : `${r.otherLabel} ${r.predicate} ${label}`)
          .join('; ')
      : 'no known relationships yet';

    return await callOpenAI([
      {
        role: 'system',
        content: 'You are a concise knowledge analyst. Given an entity name, type, and its known graph relationships, write exactly one sentence (max 30 words) describing what this entity is or its role. No preamble, no quotes — just the sentence.',
      },
      {
        role: 'user',
        content: `Entity: "${label}" (${entityType})\nRelationships: ${relText}`,
      },
    ], { temperature: 0.3 });
  } catch {
    return null;
  }
}
