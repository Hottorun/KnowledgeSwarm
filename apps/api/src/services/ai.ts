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
Rules:
- Subject and Object must be named entities (companies, people, products, markets, concepts, documents).
- Predicate must be a short verb phrase (1-4 words, e.g. "acquired", "founded by", "competes with").
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
}

export interface ExpandSubtreeResult {
  summary: string;
  newTriples: RawExtractedTriple[];
  searchQueries: string[];
  searchResultCount: number;
}

export async function expandSubtree(input: ExpandSubtreeInput): Promise<ExpandSubtreeResult> {
  const { rootNode, nodes, edges, question } = input;

  // Build a compact text summary of the subtree
  const nodeList = nodes.map(n => `${n.label} (${n.type})`).join(', ');
  const edgeList = edges.map(e => `${e.subjectLabel} --[${e.predicate}]--> ${e.objectLabel}`).join('\n');

  // Step 1: Ask the AI to generate focused web search queries for this subtree
  const queryGenPrompt = `You are a research planner for a knowledge graph tool.

The user clicked on a branch of their knowledge graph and wants it expanded with real-world information from the web.

ROOT NODE: ${rootNode.label} (${rootNode.type})

ALL NODES IN THIS BRANCH:
${nodeList || rootNode.label}

EXISTING RELATIONSHIPS IN THIS BRANCH:
${edgeList || 'None yet.'}

${question ? `USER QUESTION: ${question}` : ''}

Generate 2–3 specific, distinct web search queries that will find useful new facts, relationships, and context to expand this branch.
Queries should be concrete and targeted (include entity names, avoid generic phrases).

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

  // Step 3: AI synthesizes search results into new SPO triples
  const synthesisPrompt = `You are a knowledge graph researcher. Use the web search results below to expand a knowledge graph branch.

ROOT NODE: ${rootNode.label} (${rootNode.type})

EXISTING BRANCH:
${edgeList || 'No relationships yet.'}

${question ? `USER QUESTION: ${question}` : `GOAL: Find new entities and relationships connected to "${rootNode.label}" and its branch.`}

WEB SEARCH RESULTS:
${allWebContext.join('\n\n')}

Extract all meaningful new Subject-Predicate-Object relationships from the search results.
- Prefer relationships that connect to the existing branch nodes when possible.
- Include relationships between newly found entities too.
- Predicate must be short (1–4 words).
- subjectType/objectType: Company, Person, Market, Product, Location, Concept, Event, or Entity.
- confidence: 0–1 based on how clearly the source states this.

Also write a short summary (2–4 sentences) of the most important new findings.

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
