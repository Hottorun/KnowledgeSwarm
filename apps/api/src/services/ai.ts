import { RawExtractedTriple } from './ingestion';
import { SearchResult, performSearch } from './search';

// Runtime key takes precedence over env so the user can set it via the API
let runtimeOpenAIKey: string | null = null;

export function setRuntimeOpenAIKey(key: string): void {
  runtimeOpenAIKey = key;
}

export function getOpenAIKey(): string | null {
  return runtimeOpenAIKey || process.env.OPENAI_API_KEY || null;
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

Rules:
- Subject and Object must be named entities (companies, people, products, markets, locations) OR specific descriptive data points.
- Predicate must be a short verb phrase (1-4 words, e.g. "acquired", "founded by", "reported", "competes with").
- subjectType and objectType must be one of: Company, Person, Market, Product, Document, Location, Concept, Entity.
- confidence is 0.0–1.0 based on how explicit the relationship is in the text.
- Omit trivial, vague, or duplicate relationships.
Output ONLY valid JSON: { "triples": [ { "subject": string, "predicate": string, "object": string, "subjectType": string, "objectType": string, "confidence": number } ] }`;

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
      { jsonMode: true }
    );

    const parsed = JSON.parse(raw) as { triples?: Array<Record<string, unknown>> };
    const triples: RawExtractedTriple[] = (parsed.triples || [])
      .filter(t => t.subject && t.predicate && t.object)
      .map(t => ({
        subject: String(t.subject),
        predicate: String(t.predicate),
        object: String(t.object),
        subjectType: t.subjectType ? String(t.subjectType) : undefined,
        objectType: t.objectType ? String(t.objectType) : undefined,
        confidence: typeof t.confidence === 'number' ? t.confidence : undefined,
        source: documentName ? { documentName } : undefined,
      }));

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

export async function expandSubtree(input: ExpandSubtreeInput): Promise<ExpandSubtreeResult> {
  const { rootNode, nodes, edges, question, parentNode, siblings = [], graphDepth = 0, globalBranches = [] } = input;

  const edgeList = edges.map(e => `${e.subjectLabel} --[${e.predicate}]--> ${e.objectLabel}`).join('\n');

  // Build lineage path for context
  const lineagePath = parentNode
    ? `${parentNode.label} → ${rootNode.label}`
    : rootNode.label;

  // Depth-appropriate instruction for query generation
  const depthLabel = graphDepth === 0 ? 'root entity' : graphDepth === 1 ? 'Level 1 pillar' : graphDepth === 2 ? 'Level 2 subdivision' : `Level ${graphDepth} detail`;

  // Step 1: Ask the AI to generate focused web search queries
  const queryGenPrompt = `You are a research planner for a structured knowledge graph.

The user clicked on a node to expand it. Search for information that fits the node's level of abstraction.

TARGET NODE: "${rootNode.label}" (${rootNode.type}) — ${depthLabel}
LINEAGE: ${lineagePath}
${parentNode ? `PARENT: "${parentNode.label}"` : ''}
${question ? `USER QUESTION: ${question}` : ''}

ABSTRACTION LEVEL GUIDANCE:
${graphDepth <= 1
    ? `Level ${graphDepth}: search for high-level CATEGORIES and PILLARS of "${rootNode.label}" — not specific statistics or names yet.`
    : graphDepth === 2
      ? `Level 2: search for named SUB-DIVISIONS and key entities within "${rootNode.label}".`
      : `Level ${graphDepth}: search for SPECIFIC FACTS, statistics, names, and data points about "${rootNode.label}" under "${parentNode?.label ?? 'its parent'}".`
  }

Generate 2–3 specific, distinct web search queries that target this abstraction level.
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

  // Step 3: AI synthesizes search results into new SPO triples using the 4-rule protocol
  const allExistingLabels = [rootNode.label, ...nodes.map(n => n.label)];

  const depthRule = graphDepth <= 1
    ? `RULE 1 — BREADTH-FIRST ABSTRACTION (Level ${graphDepth}):
You MUST generate broad, abstract CATEGORY nodes — NOT leaf-level facts.
GOOD labels at this level: "Finances", "Product Lines", "Corporate Leadership", "Market Competition"
BAD labels at this level: "$4 trillion market cap", "Tim Cook is 62", specific dates or raw statistics
Only abstract organisational categories, pillars, and high-level themes are allowed here.`
    : graphDepth === 2
      ? `RULE 1 — BREADTH-FIRST ABSTRACTION (Level 2):
Generate named SUB-DIVISIONS and key entities within "${rootNode.label}". Named entities (people, products, markets) are OK.
Avoid raw statistics and highly specific data points — save those for deeper levels.`
      : `RULE 1 — SPECIFICITY UNLOCKED (Level ${graphDepth}+):
You may now include specific facts, statistics, exact names, and data points.
GOOD: "Revenue: $82.3B (Q3 2024)", "Led Vision Pro launch (2023)", "Holds 1M+ Apple shares"
BAD: still forbidden: snake_case ("sales_decline"), generic categories ("revenue_figure").
Max 60 characters per label.`;

  const synthesisPrompt = `You are a structured Knowledge Graph Architect. Apply ALL four rules below strictly.

════════════════════════════════════════
TARGET NODE: "${rootNode.label}" (${rootNode.type})
LINEAGE PATH: ${lineagePath}
GRAPH DEPTH: Level ${graphDepth}
${parentNode ? `PARENT: "${parentNode.label}"` : ''}
════════════════════════════════════════

SIBLINGS ALREADY ATTACHED TO PARENT (do NOT duplicate or overlap):
${siblings.length > 0 ? siblings.map(s => `• ${s}`).join('\n') : '• None yet'}

GLOBAL BRANCHES ALREADY IN GRAPH (do NOT duplicate):
${globalBranches.length > 0 ? globalBranches.map(b => `• ${b}`).join('\n') : '• None yet'}

ALL EXISTING NODE LABELS (strict deduplication — reuse exact strings for these):
${allExistingLabels.join(', ')}

EXISTING RELATIONSHIPS:
${edgeList || 'None yet.'}

${question ? `USER QUESTION: ${question}` : `GOAL: Generate exactly 5 logical sub-nodes of "${rootNode.label}" following the protocol.`}

WEB SEARCH RESULTS:
${allWebContext.join('\n\n')}

════ MANDATORY RULES ════

${depthRule}

RULE 2 — ANTI-DUPLICATION:
• Do NOT create any node whose label overlaps (case-insensitive) with any sibling or global branch listed above.
• If a concept already exists in the graph, reference it via an edge rather than creating a new node.

RULE 3 — HIERARCHICAL CONTEXT:
• Every new node must be a direct, logical sub-category or attribute of "${rootNode.label}" specifically.
• Stay within the lineage: ${lineagePath}.
• Do NOT revert to generic facts about the parent entity "${parentNode?.label ?? 'root'}".
• Example: expanding "Corporate Leadership" under "Apple Inc" → generate "Board of Directors", "Executive Team", "Leadership History" — NOT "Apple Revenue" or "iPhone Sales".

RULE 4 — DIRECT CONNECTION:
• Every new relationship MUST have "${rootNode.label}" as either subject or object.
• Do NOT generate triples between two third-party entities.

Also write a 2–3 sentence summary of the most important new findings specifically about "${rootNode.label}".

Output JSON: {
  "summary": string,
  "newRelationships": [
    { "subject": string, "predicate": string, "object": string, "subjectType": string, "objectType": string, "confidence": number, "sourceIndex": number }
  ]
}`;

  const synthesisRaw = await callOpenAI(
    [{ role: 'user', content: synthesisPrompt }],
    { model: 'gpt-4o-mini', jsonMode: true, temperature: 0.1 }
  );

  const synthParsed = JSON.parse(synthesisRaw) as {
    summary?: string;
    newRelationships?: Array<Record<string, unknown>>;
  };

  const summary = synthParsed.summary || `Expanded branch for "${rootNode.label}" using web research.`;

  const newTriples: RawExtractedTriple[] = (synthParsed.newRelationships || [])
    .filter(r => r.subject && r.predicate && r.object)
    .map(r => {
      const sourceIdx = typeof r.sourceIndex === 'number' ? r.sourceIndex : 0;
      const matchedResult = allSearchResults[sourceIdx];
      return {
        subject: String(r.subject),
        predicate: String(r.predicate),
        object: String(r.object),
        subjectType: r.subjectType ? String(r.subjectType) : undefined,
        objectType: r.objectType ? String(r.objectType) : undefined,
        confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.7,
        source: {
          url: matchedResult?.url,
          title: matchedResult?.title,
          snippet: matchedResult?.snippet,
        },
      };
    });

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
