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

// When the LLM's own decomposition says the property OWNER is not the root,
// reject any triple that jams the property directly onto the root node. The
// model occasionally ignores Rule 0 even when it correctly fills out the
// decomposition block, so this is the belt-and-suspenders enforcement.
function enforceMultiHopChain(
  triples: RawExtractedTriple[],
  rootLabel: string,
  decomp?: {
    attribute?: string;
    owner?: string;
    ownerIsRoot?: boolean;
    intermediateNeeded?: string | null;
  },
): RawExtractedTriple[] {
  if (!decomp) return triples;
  if (decomp.ownerIsRoot !== false) return triples;

  const norm = (s: string) => s.toLowerCase().trim();
  const root = norm(rootLabel);
  const attribute = decomp.attribute ? norm(decomp.attribute) : '';
  const owner = decomp.owner ? norm(decomp.owner) : '';
  // Tokenize attribute into words ≥3 chars to match against snake_case predicates
  const attrTokens = attribute
    .split(/[\s_]+/)
    .filter(t => t.length >= 3 && t !== 'the' && t !== 'and' && t !== 'for');
  const ownerTokens = owner
    .split(/[\s_]+/)
    .filter(t => t.length >= 3 && t !== 'the' && t !== 'and' && t !== 'for');

  return triples.filter(t => {
    if (norm(t.subject) !== root) return true;
    const predicate = norm(t.predicate);
    const object = norm(t.object);
    // If the root is the subject, the predicate must NOT contain attribute keywords
    // unless the object is the intermediate (i.e. the chain root → owner).
    const predicateMentionsAttribute = attrTokens.some(tok => predicate.includes(tok));
    const predicateMentionsOwner = ownerTokens.some(tok => predicate.includes(tok));
    const objectIsIntermediate = decomp.intermediateNeeded
      ? object.includes(norm(decomp.intermediateNeeded))
      : ownerTokens.some(tok => object.includes(tok));
    // Drop: root → ceo_age → "47"  (predicate has both owner and attribute)
    // Drop: root → has_ceo_age → "47"
    // Drop: root → age → "47"      (predicate is the attribute itself)
    // Keep: root → has_ceo → "Jane Smith"  (object is intermediate, predicate is just owner relation)
    if (predicateMentionsAttribute && predicateMentionsOwner) return false;
    if (predicateMentionsAttribute && !objectIsIntermediate) return false;
    return true;
  });
}

// BFS over the LLM's new triples starting from rootLabel. Drops triples whose
// endpoints can't be reached from the root through other new triples — this is
// what kills orphan nodes that would otherwise float in the canvas with no edge
// connecting them back to the user's clicked node.
function filterToConnectedTriples(
  triples: RawExtractedTriple[],
  rootLabel: string,
): RawExtractedTriple[] {
  if (triples.length === 0) return triples;

  const norm = (s: string) => s.toLowerCase().trim();
  const root = norm(rootLabel);

  const reachable = new Set<string>([root]);
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

export async function expandSubtree(input: ExpandSubtreeInput): Promise<ExpandSubtreeResult> {
  const { rootNode, nodes, edges, question, parentNode, siblings = [], graphDepth = 0, globalBranches = [] } = input;

  const edgeList = edges.map(e => `${e.subjectLabel} --[${e.predicate}]--> ${e.objectLabel}`).join('\n');

  // Build lineage path for context
  const lineagePath = parentNode
    ? `${parentNode.label} → ${rootNode.label}`
    : rootNode.label;

  // Depth-appropriate instruction for query generation
  const depthLabel =
    graphDepth === 0 ? 'root entity'
    : graphDepth === 1 ? 'Level 1 pillar'
    : graphDepth === 2 ? 'Level 2 subdivision'
    : graphDepth === 3 ? 'Level 3 specific entity/fact'
    : `Level ${graphDepth} fine-grained detail`;

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

  // Step 3: AI synthesizes search results into new SPO triples using the 4-rule protocol
  const allExistingLabels = [rootNode.label, ...nodes.map(n => n.label)];

  const depthRule = userQuestionDriven
    ? `RULE 1 — QUESTION-DRIVEN (user override active):
The user's question takes priority over abstraction defaults. Answer it directly with whatever specificity the question demands.
Still: NO snake_case labels, NO vague category words. Every label must be a specific, human-readable phrase or fact (max 60 chars).`
    : graphDepth <= 1
      ? `RULE 1 — BREADTH-FIRST ABSTRACTION (Level ${graphDepth}) — STRICT:
You MUST generate ONLY broad, abstract CATEGORY nodes. Leaf-level facts are FORBIDDEN at this level.
GOOD: "Finances", "Product Lines", "Corporate Leadership", "Market Competition", "Brand Identity", "Manufacturing"
BAD (will be REJECTED): "$4 trillion market cap", "Tim Cook is 62", "iPhone 15 Pro", any number, any specific date, any individual person's name, any product name.
If you cannot think of an abstract category, output FEWER nodes — never substitute a leaf fact.`
      : graphDepth === 2
        ? `RULE 1 — NAMED SUB-DIVISIONS (Level 2):
Generate named SUB-DIVISIONS and key entities within "${rootNode.label}". Named entities (people, products, markets, departments) are OK.
Still avoid raw statistics, exact figures, and dates — save those for deeper levels.`
        : graphDepth === 3
          ? `RULE 1 — SPECIFICITY UNLOCKED (Level 3):
You may now include specific facts, statistics, exact names, and data points.
GOOD: "Revenue: $82.3B (Q3 2024)", "Led Vision Pro launch (2023)", "Holds 1M+ Apple shares"
BAD: still forbidden: snake_case ("sales_decline"), generic categories ("revenue_figure").
Max 60 characters per label.`
          : `RULE 1 — DEEP DRILLDOWN (Level ${graphDepth}):
You are deep in the graph — go MORE granular, not less. Atomic facts, micro-attributes, exact dates, unit-level details.
GOOD: "Released Sept 12, 2023", "Battery: 3,279 mAh", "Manufactured at Foxconn Zhengzhou"
BAD: anything generic. If you can't find truly atomic facts, return fewer nodes rather than padding with vague ones.
Max 60 characters per label.`;

  const synthesisPrompt = `You are a structured Knowledge Graph Architect. Apply ALL rules below strictly.

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

RULE 0 — QUESTION DECOMPOSITION (DO THIS FIRST, MENTALLY):
${userQuestionDriven
  ? `Before generating any triples, decompose the user's question into:
  (a) ATTRIBUTE — what is the user actually asking about? (e.g. "age", "salary", "release date", "founder")
  (b) OWNER — which entity logically POSSESSES that attribute? (e.g. "the CEO", "the founder", "the iPhone 15")

Then check: is the OWNER the same as "${rootNode.label}"?

  • OWNER == "${rootNode.label}"  → attach the attribute directly to "${rootNode.label}".
        Example: question "revenue in 2023" on root "Acme Corp"
          OK:  Acme Corp --[revenue_2023]--> "$2.1B"

  • OWNER != "${rootNode.label}"  → you MUST first create the OWNER as a child of "${rootNode.label}",
        THEN attach the attribute to the OWNER. NEVER jam them into one predicate.

        Example: question "age of the CEO" on root "Acme Corp"
          REQUIRED CHAIN:
            Acme Corp --[has_ceo]--> "Jane Smith"
            "Jane Smith" --[age]--> "47"
          STRICTLY FORBIDDEN — these will be REJECTED:
            Acme Corp --[ceo_age]--> "47"
            Acme Corp --[has_ceo_age]--> "47"
            Acme Corp --[age_of_ceo]--> "47"
            Acme Corp --[ceo_is_47]--> "47"

  • If the OWNER already exists in ALL EXISTING NODE LABELS above, reuse that exact label string.
  • Compound predicates (snake_case combining two concepts like "founder_age", "ceo_salary",
    "product_release_date") are FORBIDDEN. Always split them into a chain.`
  : `No user question — focus on generating direct sub-categories of "${rootNode.label}".`}

${depthRule}

RULE 2 — ANTI-DUPLICATION:
• Do NOT create any node whose label overlaps (case-insensitive) with any sibling or global branch listed above.
• If a concept already exists in the graph, reference it via an edge rather than creating a new node.

RULE 3 — HIERARCHICAL CONTEXT:
• Every new node must be a direct, logical sub-category or attribute of "${rootNode.label}" specifically.
• Stay within the lineage: ${lineagePath}.
• Do NOT revert to generic facts about the parent entity "${parentNode?.label ?? 'root'}".
• Example: expanding "Corporate Leadership" under "Apple Inc" → generate "Board of Directors", "Executive Team", "Leadership History" — NOT "Apple Revenue" or "iPhone Sales".

RULE 4 — REACHABLE FROM ROOT (no orphan triples):
Every new node must be reachable from "${rootNode.label}" through a chain of new triples.
• At least one triple MUST have "${rootNode.label}" exactly as subject.
• Every other new node MUST be transitively reachable from "${rootNode.label}" via the new triples you generate.
• Triples between two third-party entities that don't connect back to "${rootNode.label}" are FORBIDDEN — they will be dropped.
• Before submitting, mentally trace: can I walk from "${rootNode.label}" to every new node using only new triples? If no → remove that triple.

Also write a 2–3 sentence summary of the most important new findings specifically about "${rootNode.label}".

You MUST output the questionDecomposition block FIRST. This forces you to think through the chain structure before writing triples. The block is mandatory whether or not the user asked a question.

Output JSON: {
  "questionDecomposition": {
    "attribute": string,        // what the user asks about, or the broadest theme if no question (e.g. "categories of ${rootNode.label}")
    "owner": string,            // who possesses the attribute — "${rootNode.label}" itself, or a sub-entity by name/role
    "ownerIsRoot": boolean,     // true ⇔ owner === "${rootNode.label}"
    "intermediateNeeded": string | null,  // if ownerIsRoot is false, the EXACT label of the intermediate node you will create (or reuse from the existing graph)
    "plan": string              // 1 sentence: how the chain will look, e.g. "${rootNode.label} → has_ceo → 'Jane Smith' → age → '47'"
  },
  "summary": string,
  "newRelationships": [
    { "subject": string, "predicate": string, "object": string, "subjectType": string, "objectType": string, "confidence": number, "sourceIndex": number }
  ]
}

Self-check before returning: if questionDecomposition.ownerIsRoot is false, then NO triple may have "${rootNode.label}" as subject AND the attribute keyword in the predicate — instead "${rootNode.label}" must be the subject of a triple whose object is the intermediateNeeded label.`;

  const synthesisRaw = await callOpenAI(
    [{ role: 'user', content: synthesisPrompt }],
    { model: 'gpt-4o-mini', jsonMode: true, temperature: 0.1 }
  );

  const synthParsed = JSON.parse(synthesisRaw) as {
    summary?: string;
    newRelationships?: Array<Record<string, unknown>>;
    questionDecomposition?: {
      attribute?: string;
      owner?: string;
      ownerIsRoot?: boolean;
      intermediateNeeded?: string | null;
      plan?: string;
    };
  };

  const summary = synthParsed.summary || `Expanded branch for "${rootNode.label}" using web research.`;
  const decomp = synthParsed.questionDecomposition;

  const rawTriples: RawExtractedTriple[] = (synthParsed.newRelationships || [])
    .filter(r => r.subject && r.predicate && r.object)
    .map(r => {
      const sourceIdx = typeof r.sourceIndex === 'number' ? r.sourceIndex : 0;
      const matchedResult = allSearchResults[sourceIdx];
      return {
        subject: String(r.subject).trim(),
        predicate: String(r.predicate).trim(),
        object: String(r.object).trim(),
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

  const cleanedTriples = enforceMultiHopChain(rawTriples, rootNode.label, decomp);
  const newTriples = filterToConnectedTriples(cleanedTriples, rootNode.label);

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
