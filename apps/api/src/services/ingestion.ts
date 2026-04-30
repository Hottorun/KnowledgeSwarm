import { Triple } from './graph';

export interface RawSource {
  url?: string;
  title?: string;
  snippet?: string;
  documentName?: string;
  page?: number;
  row?: number;
}

export interface RawExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
  subjectType?: string;
  objectType?: string;
  confidence?: number;
  source?: RawSource;
  properties?: Record<string, unknown>;
}

export interface TextChunk {
  index: number;
  text: string;
  startWord: number;
  endWord: number;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'as']);
const PREDICATE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'with', 'by', 'to', 'from', 'in', 'on', 'for']);

export function chunkText(text: string, chunkSize = 500, overlap = 50): TextChunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= chunkSize) {
    return [{ index: 0, text: words.join(' '), startWord: 0, endWord: words.length }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push({
      index: chunks.length,
      text: words.slice(start, end).join(' '),
      startWord: start,
      endWord: end,
    });

    if (end === words.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function normalizeEntityLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function entityId(label: string, type = 'Entity'): string {
  const normalizedType = slugify(type || 'Entity');
  const normalizedLabel = slugify(normalizeComparableText(label));
  return `${normalizedType}:${normalizedLabel || 'unknown'}`;
}

export function normalizePredicate(predicate: string, maxWords = 4): string {
  const words = predicate
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  let limited = words.slice(0, maxWords);
  while (limited.length > 1 && PREDICATE_STOPWORDS.has(limited[limited.length - 1].toLowerCase())) {
    limited = limited.slice(0, -1);
  }

  return limited.join('_').toLowerCase() || 'related_to';
}

export function normalizeExtractedTriples(agentName: string | undefined, rawTriples: RawExtractedTriple[]): Triple[] {
  return rawTriples
    .map(raw => {
      const subjectLabel = normalizeEntityLabel(raw.subject);
      const objectLabel = normalizeEntityLabel(raw.object);
      const subjectType = raw.subjectType || inferEntityType(subjectLabel);
      const objectType = raw.objectType || inferEntityType(objectLabel);

      return {
        agentName,
        subject: {
          id: entityId(subjectLabel, subjectType),
          label: subjectLabel,
          type: subjectType,
          properties: {},
        },
        predicate: normalizePredicate(raw.predicate),
        object: {
          id: entityId(objectLabel, objectType),
          label: objectLabel,
          type: objectType,
          properties: {},
        },
        confidence: clampConfidence(raw.confidence),
        sources: raw.source ? [toGraphSource(raw.source)] : [],
        properties: raw.properties || {},
      };
    })
    .filter(triple => triple.subject.id !== triple.object.id);
}

function toGraphSource(source: RawSource): { url: string; title?: string; snippet?: string } {
  const title = source.title || source.documentName || 'Uploaded source';
  const location = [
    source.page ? `page ${source.page}` : undefined,
    source.row ? `row ${source.row}` : undefined,
  ].filter(Boolean).join(', ');

  return {
    url: source.url || `local://${encodeURIComponent(source.documentName || 'uploaded-source')}`,
    title,
    snippet: source.snippet || location || undefined,
  };
}

function inferEntityType(label: string): string {
  if (/inc\.?|corp\.?|llc|ltd\.?|gmbh|company|bank|group/i.test(label)) return 'Company';
  if (/market|industry|sector/i.test(label)) return 'Market';
  if (/report|agreement|contract|filing|pdf|spreadsheet/i.test(label)) return 'Document';
  if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(label)) return 'Person';
  return 'Entity';
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(word => word && !STOPWORDS.has(word))
    .join(' ');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function clampConfidence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(1, value));
}
