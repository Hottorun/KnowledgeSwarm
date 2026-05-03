import type { GraphNode, Triple } from '../types';
import { CATEGORIES, type CategoryKey } from './categories';

interface CategorySummary {
  overview: string;
  topFacts: string[];
  keyDocuments: string[];
  risksOrOpenQuestions: string[];
}

// Re-export so callers that already import these from presentation keep working.
export type { CategoryKey } from './categories';
export { CATEGORIES } from './categories';

const DOCUMENTS_CATEGORY: GraphNode = {
  id: 'category:documents',
  label: 'Documents',
  type: 'Category',
  properties: {
    category: 'documents',
    presentationRole: 'business_area',
  },
};

// Classification handed in from the DocumentClassifierAgent. We honour the
// primary category for the document scaffold (overrides keyword-based
// dominantCategory) and propagate it through to triples that lack a category
// of their own. Heuristic inference still runs for triples whose document name
// has no classification entry.
export interface DocumentCategoryAssignment {
  primaryCategory: CategoryKey;
  secondaryCategories: CategoryKey[];
  source: 'model' | 'heuristic';
}

export function buildPresentationTriples(
  extractedTriples: Triple[],
  fallbackDocumentName: string,
  documentSummaries: Map<string, string> = new Map(),
  preselectedMainEntity?: GraphNode,
  documentClassifications: Map<string, DocumentCategoryAssignment> = new Map(),
): Triple[] {
  if (extractedTriples.length === 0) return [];

  const rawMainEntity = preselectedMainEntity ?? chooseMainEntity(extractedTriples);
  if (!rawMainEntity) return [];
  const mainEntity: GraphNode = {
    ...rawMainEntity,
    properties: {
      ...(rawMainEntity.properties ?? {}),
      presentationRole: 'main_entity',
    },
  };

  const triplesByCategory = new Map<CategoryKey, Triple[]>();
  const triplesByDocument = new Map<string, Triple[]>();

  for (const triple of extractedTriples) {
    const documentName = getDocumentName(triple, fallbackDocumentName);
    const assigned = documentClassifications.get(documentName)?.primaryCategory;
    const category = assigned ?? inferCategory(triple);
    triplesByCategory.set(category, [...(triplesByCategory.get(category) ?? []), triple]);
    triplesByDocument.set(documentName, [...(triplesByDocument.get(documentName) ?? []), triple]);
  }

  const presentationTriples: Triple[] = [];
  const usedCategoryKeys = [...triplesByCategory.keys()];

  for (const categoryKey of usedCategoryKeys) {
    const categoryTriples = triplesByCategory.get(categoryKey) ?? [];
    const categoryNode = categoryNodeFor(categoryKey, summarizeCategoryBranch(categoryKey, categoryTriples, fallbackDocumentName));
    presentationTriples.push({
      subject: mainEntity,
      predicate: 'has_business_area',
      object: categoryNode,
      confidence: 0.95,
      properties: {
        presentation: true,
        category: categoryKey,
        importance: 0.96,
      },
    });
  }

  const documentNames = [...triplesByDocument.keys()].map(cleanDocumentName);
  presentationTriples.push({
    subject: mainEntity,
    predicate: 'has_business_area',
    object: documentsCategoryNode(documentNames),
    confidence: 0.95,
    properties: {
      presentation: true,
      category: 'documents',
      importance: 0.94,
    },
  });

  for (const [documentName, documentTriples] of triplesByDocument) {
    const assignment = documentClassifications.get(documentName);
    const category = assignment?.primaryCategory ?? dominantCategory(documentTriples);
    const documentNode = documentNodeFor(
      documentName,
      category,
      documentSummaries.get(documentName) || summarizeDocumentEvidence(documentTriples),
      assignment,
    );
    const categoryNode = categoryNodeFor(category, summarizeCategoryBranch(category, triplesByCategory.get(category) ?? documentTriples, fallbackDocumentName));

    presentationTriples.push({
      subject: documentsCategoryNode(documentNames),
      predicate: 'contains_document',
      object: documentNode,
      confidence: 0.95,
      sources: documentSource(documentName),
      properties: {
        presentation: true,
        category: 'documents',
        importance: 0.9,
      },
    });

    presentationTriples.push({
      subject: categoryNode,
      predicate: 'contains_document',
      object: documentNode,
      confidence: 0.9,
      sources: documentSource(documentName),
      properties: {
        presentation: true,
        category,
        importance: 0.88,
      },
    });

    // Secondary categories from the classifier — link the document to each
    // additional area at lower confidence so it shows up under multiple
    // business areas without dominating any of them.
    for (const secondary of assignment?.secondaryCategories ?? []) {
      if (secondary === category) continue;
      const secondaryNode = categoryNodeFor(
        secondary,
        summarizeCategoryBranch(secondary, triplesByCategory.get(secondary) ?? documentTriples, fallbackDocumentName),
      );
      presentationTriples.push({
        subject: secondaryNode,
        predicate: 'contains_document',
        object: documentNode,
        confidence: 0.7,
        sources: documentSource(documentName),
        properties: {
          presentation: true,
          category: secondary,
          importance: 0.74,
          secondary: true,
        },
      });
    }

    for (const node of topDocumentNodes(documentTriples, mainEntity.id, 24)) {
      presentationTriples.push({
        subject: documentNode,
        predicate: 'mentions',
        object: node,
        confidence: 0.85,
        sources: documentSource(documentName),
        properties: {
          presentation: true,
          category,
          importance: 0.78,
        },
      });
    }
  }

  return presentationTriples;
}

export function annotateTriplesForPresentation(
  triples: Triple[],
  fallbackDocumentName: string,
  documentClassifications: Map<string, DocumentCategoryAssignment> = new Map(),
): Triple[] {
  return triples.map(triple => {
    const documentName = getDocumentName(triple, fallbackDocumentName);
    // Resolution order: worker-emitted category > document classifier > keyword inference.
    // The worker has the chunk in front of it, so its judgement is more specific
    // than the doc-level classification when both are present.
    const workerCategory = coerceTripleCategory(triple.properties?.category);
    const assigned = documentClassifications.get(documentName)?.primaryCategory;
    const category = workerCategory ?? assigned ?? inferCategory(triple);
    return {
      ...triple,
      subject: {
        ...triple.subject,
        properties: {
          ...(triple.subject.properties ?? {}),
          category: triple.subject.properties?.category ?? category,
        },
      },
      object: {
        ...triple.object,
        properties: {
          ...(triple.object.properties ?? {}),
          category: triple.object.properties?.category ?? category,
        },
      },
      properties: {
        ...(triple.properties ?? {}),
        category,
        documentName,
        importance: typeof triple.properties?.importance === 'number'
          ? triple.properties.importance
          : inferImportance(triple),
      },
    };
  });
}

function chooseMainEntity(triples: Triple[]): GraphNode | null {
  const scores = new Map<string, { node: GraphNode; score: number; subjectCount: number }>();

  for (const triple of triples) {
    for (const [node, roleWeight] of [[triple.subject, 1.25], [triple.object, 1]] as const) {
      const type = node.type.toLowerCase();
      // Documents and categories are scaffold structure, never the main entity.
      if (type === 'document' || type === 'category') continue;
      const typeScore = type.includes('company') ? 6 : type.includes('organization') ? 5 : type.includes('entity') ? 2 : 1;
      const edgeScore = (triple.confidence ?? 0.75) * typeScore * roleWeight;
      const current = scores.get(node.id) ?? { node, score: 0, subjectCount: 0 };
      current.score += edgeScore;
      if (node.id === triple.subject.id) current.subjectCount++;
      scores.set(node.id, current);
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || b.subjectCount - a.subjectCount)
    [0]?.node ?? null;
}

// Read a category off triple.properties.category if the worker emitted one.
// Returns null when missing/invalid so callers can fall back to other sources.
function coerceTripleCategory(value: unknown): CategoryKey | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return CATEGORIES.some(category => category.key === normalized)
    ? (normalized as CategoryKey)
    : null;
}

function inferCategory(triple: Triple): CategoryKey {
  // Worker may have emitted a category directly on the triple — honour that
  // before keyword scanning, which is much weaker.
  const workerCategory = coerceTripleCategory(triple.properties?.category);
  if (workerCategory) return workerCategory;

  const text = [
    triple.subject.label,
    triple.subject.type,
    triple.predicate,
    triple.object.label,
    triple.object.type,
    ...(triple.sources ?? []).flatMap(source => [source.title ?? '', source.snippet ?? '', source.url ?? '']),
  ].join(' ').toLowerCase();

  const textCategory = CATEGORIES.find(category => category.keywords.some(keyword => text.includes(keyword)))?.key;
  if (textCategory) return textCategory;

  const specialist = String(triple.properties?.specialist ?? '').toLowerCase();
  if (specialist === 'people') return 'hr-people';
  if (specialist === 'market') return 'strategy-market';
  if (specialist === 'technical') return 'technology';
  if (specialist === 'finance' || specialist === 'legal' || specialist === 'risk') return specialist;

  return 'other';
}

function dominantCategory(triples: Triple[]): CategoryKey {
  const counts = new Map<CategoryKey, number>();
  for (const triple of triples) {
    const category = inferCategory(triple);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
}

function categoryNodeFor(key: CategoryKey, summary?: CategorySummary): GraphNode {
  const def = CATEGORIES.find(category => category.key === key);
  const overview = summary?.overview;
  return {
    id: `category:${key}`,
    label: def?.label ?? 'Other',
    type: 'Category',
    properties: {
      category: key,
      presentationRole: 'business_area',
      ...(summary ? {
        summary: overview,
        overview,
        topFacts: summary.topFacts,
        keyDocuments: summary.keyDocuments,
        risksOrOpenQuestions: summary.risksOrOpenQuestions,
      } : {}),
    },
  };
}

function documentsCategoryNode(documentNames: string[]): GraphNode {
  const keyDocuments = [...new Set(documentNames)].slice(0, 12);
  const overview = keyDocuments.length > 0
    ? `Contains ${formatList(keyDocuments.slice(0, 5))}${keyDocuments.length > 5 ? ` and ${keyDocuments.length - 5} more document${keyDocuments.length - 5 === 1 ? '' : 's'}` : ''}.`
    : 'Contains source documents used to build this graph.';

  return {
    ...DOCUMENTS_CATEGORY,
    properties: {
      ...DOCUMENTS_CATEGORY.properties,
      summary: overview,
      overview,
      keyDocuments,
      topFacts: [],
      risksOrOpenQuestions: [],
    },
  };
}

function summarizeCategoryBranch(
  categoryKey: CategoryKey,
  triples: Triple[],
  fallbackDocumentName: string,
): CategorySummary {
  const label = CATEGORIES.find(category => category.key === categoryKey)?.label ?? 'Other';
  const keyDocuments = [...new Set(triples.map(triple => cleanDocumentName(getDocumentName(triple, fallbackDocumentName))))]
    .filter(Boolean)
    .slice(0, 8);
  const topFacts = triples
    .map(triple => ({ text: factSentence(triple), score: inferImportance(triple) }))
    .filter(item => item.text.length > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.text)
    .filter((fact, index, all) => all.indexOf(fact) === index)
    .slice(0, 5);
  const risksOrOpenQuestions = triples
    .filter(triple => {
      const text = `${triple.subject.label} ${triple.predicate} ${triple.object.label}`.toLowerCase();
      return /\b(risk|exposure|liability|delay|dependency|obligation|compliance|breach|constraint|vulnerability)\b/.test(text);
    })
    .map(factSentence)
    .filter((fact, index, all) => fact && all.indexOf(fact) === index)
    .slice(0, 4);

  const documentPart = keyDocuments.length > 0
    ? `${label} draws from ${formatList(keyDocuments.slice(0, 4))}.`
    : `${label} contains extracted evidence from the provided sources.`;
  const factPart = topFacts.length > 0
    ? `Key findings: ${topFacts.slice(0, 2).join(' ')}`
    : 'No high-confidence category facts have been extracted yet.';
  const riskPart = risksOrOpenQuestions.length > 0
    ? `Watch items: ${risksOrOpenQuestions.slice(0, 2).join(' ')}`
    : '';
  const overview = [documentPart, factPart, riskPart].filter(Boolean).join(' ');

  return {
    overview: overview.length > 700 ? `${overview.slice(0, 697).trim()}...` : overview,
    topFacts,
    keyDocuments,
    risksOrOpenQuestions,
  };
}

function factSentence(triple: Triple): string {
  const subject = triple.subject.label.trim();
  const predicate = triple.predicate.replace(/[_-]+/g, ' ').trim();
  const object = triple.object.label.trim();
  if (!subject || !object || !predicate) return '';
  return `${subject} ${predicate} ${object}.`;
}

function formatList(values: string[]): string {
  const clean = values.filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

export function summarizeDocumentText(text: string, maxSentences = 3): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/\b(page|section)\s+\d+\b/gi, '')
    .trim();

  if (!normalized) return '';

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 40 && sentence.length <= 320)
    .filter(sentence => !/^(table of contents|copyright|confidential)$/i.test(sentence));

  const scored = sentences.map((sentence, index) => ({
    sentence,
    score: scoreSummarySentence(sentence, index),
  }));

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => sentences.indexOf(a.sentence) - sentences.indexOf(b.sentence))
    .map(item => item.sentence);

  const summary = selected.length > 0
    ? selected.join(' ')
    : normalized.slice(0, 500);

  return summary.length > 700 ? `${summary.slice(0, 697).trim()}...` : summary;
}

function scoreSummarySentence(sentence: string, index: number): number {
  const text = sentence.toLowerCase();
  let score = Math.max(0, 8 - index * 0.15);

  const signals = [
    'revenue',
    'contract',
    'agreement',
    'risk',
    'customer',
    'employee',
    'supplier',
    'market',
    'product',
    'technology',
    'patent',
    'obligation',
    'company',
    'reported',
    'operates',
    'acquired',
  ];

  for (const signal of signals) {
    if (text.includes(signal)) score += 2;
  }
  if (/\$|%|\b\d{4}\b|\b\d+(\.\d+)?\s?(million|billion|m|bn)\b/i.test(sentence)) score += 2;
  if (sentence.length > 220) score -= 1;

  return score;
}

function documentNodeFor(
  documentName: string,
  category: CategoryKey,
  summary: string,
  classification?: DocumentCategoryAssignment,
): GraphNode {
  return {
    id: `document:${slugify(documentName)}`,
    label: cleanDocumentName(documentName),
    type: 'Document',
    properties: {
      documentName,
      summary,
      category,
      presentationRole: 'document',
      sourceKind: documentName === 'MCP files' ? 'mcp' : 'upload',
      ...(classification ? {
        secondaryCategories: classification.secondaryCategories,
        categorySource: classification.source,
      } : {}),
    },
  };
}

function getDocumentName(triple: Triple, fallbackDocumentName: string): string {
  const propertyName = typeof triple.properties?.documentName === 'string'
    ? triple.properties.documentName
    : undefined;
  const sourceTitle = triple.sources?.find(source => source.title)?.title;
  const sourceUrl = triple.sources?.find(source => source.url)?.url;
  return propertyName || sourceTitle || sourceUrl?.replace(/^local:\/\//, '') || fallbackDocumentName;
}

function summarizeDocumentEvidence(triples: Triple[]): string {
  const snippets = triples
    .flatMap(triple => triple.sources ?? [])
    .map(source => source.snippet?.trim())
    .filter((snippet): snippet is string => Boolean(snippet))
    .filter((snippet, index, all) => all.indexOf(snippet) === index)
    .slice(0, 3);

  if (snippets.length > 0) return snippets.join(' ');

  return triples
    .slice(0, 3)
    .map(triple => `${triple.subject.label} ${triple.predicate.replace(/[_-]+/g, ' ')} ${triple.object.label}.`)
    .join(' ');
}

function topDocumentNodes(triples: Triple[], mainEntityId: string, limit: number): GraphNode[] {
  const scores = new Map<string, { node: GraphNode; score: number }>();

  for (const triple of triples) {
    for (const node of [triple.subject, triple.object]) {
      if (node.id === mainEntityId) continue;
      const current = scores.get(node.id) ?? { node, score: 0 };
      current.score += (triple.confidence ?? 0.75) + inferImportance(triple) + nodeImportanceBonus(node);
      scores.set(node.id, current);
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.node);
}

function inferImportance(triple: Triple): number {
  const text = [
    triple.subject.label,
    triple.subject.type,
    triple.predicate,
    triple.object.label,
    triple.object.type,
    ...(triple.sources ?? []).flatMap(source => [source.title ?? '', source.snippet ?? '']),
  ].join(' ').toLowerCase();

  let score = 0.62;
  const confidence = triple.confidence ?? 0.75;
  score += Math.max(0, Math.min(0.12, (confidence - 0.7) * 0.4));

  if (/\b(company|organization|subsidiary|parent|acquired|owns|partner|customer|supplier)\b/.test(text)) score += 0.08;
  if (/\b(revenue|profit|margin|valuation|funding|debt|budget|cost|payment|invoice|salary)\b|\$|%/.test(text)) score += 0.16;
  if (/\b(contract|agreement|patent|license|obligation|jurisdiction|compliance|termination|confidentiality)\b/.test(text)) score += 0.14;
  if (/\b(risk|exposure|liability|breach|dependency|vulnerability|mitigation|delay|constraint)\b/.test(text)) score += 0.14;
  if (/\b(ceo|cfo|cto|founder|director|vp|head|manager|reports to|responsible for)\b/.test(text)) score += 0.12;
  if (/\b(product|platform|api|database|system|security|integration|warehouse|shipment|inventory|manufacturing)\b/.test(text)) score += 0.1;
  if (/\b\d{4}\b|\bq[1-4]\b|\b\d+(\.\d+)?\s?(million|billion|m|bn)\b/.test(text)) score += 0.08;

  const predicate = triple.predicate.toLowerCase();
  if (/^(mentions|relates_to|associated_with|has|is|includes)$/.test(predicate)) score -= 0.08;

  return Math.max(0.5, Math.min(0.98, Number(score.toFixed(2))));
}

function nodeImportanceBonus(node: GraphNode): number {
  const text = `${node.type} ${node.label}`.toLowerCase();
  if (/\b(company|organization|person|contract|risk|financial|product|technology|facility)\b/.test(text)) return 0.12;
  if (/\b(date|amount|metric|location|market|supplier|customer)\b/.test(text)) return 0.08;
  return 0;
}

function documentSource(documentName: string): Triple['sources'] {
  return [{
    url: `local://${encodeURIComponent(documentName)}`,
    title: cleanDocumentName(documentName),
  }];
}

function cleanDocumentName(documentName: string): string {
  return decodeURIComponent(documentName.replace(/^local:\/\//, '')).replace(/\.[^/.]+$/, '');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document';
}
