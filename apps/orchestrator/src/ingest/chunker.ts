import { config } from '../config';
import type { DocumentChunk } from '../types';

export function chunkText(text: string): DocumentChunk[] {
  const { chunkWords, chunkOverlapWords } = config;

  // Split into paragraphs first so we don't cut mid-sentence
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

  const chunks: DocumentChunk[] = [];
  let currentWords: string[] = [];
  let currentStartChar = 0;
  let charCursor = 0;

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/);

    for (const word of words) {
      currentWords.push(word);

      if (currentWords.length >= chunkWords) {
        const chunkText = currentWords.join(' ');
        chunks.push({
          index: chunks.length,
          text: chunkText,
          startChar: currentStartChar,
          endChar: currentStartChar + chunkText.length,
        });

        // Keep overlap words for the next chunk
        currentWords = currentWords.slice(-chunkOverlapWords);
        currentStartChar = charCursor - currentWords.join(' ').length;
      }

      charCursor += word.length + 1;
    }

    charCursor++; // paragraph separator
  }

  // Flush the remaining words as a final chunk
  if (currentWords.length > 10) {
    const chunkText = currentWords.join(' ');
    chunks.push({
      index: chunks.length,
      text: chunkText,
      startChar: currentStartChar,
      endChar: currentStartChar + chunkText.length,
    });
  }

  return chunks.length > 0 ? chunks : [{ index: 0, text: text.trim(), startChar: 0, endChar: text.length }];
}

// Returns a short summary of the document for the meta-agent to read
export function buildDocumentSummary(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const half = Math.floor(maxChars / 2);
  const start = trimmed.slice(0, half);
  const end = trimmed.slice(-half);
  return `${start}\n\n[...document continues...]\n\n${end}`;
}
