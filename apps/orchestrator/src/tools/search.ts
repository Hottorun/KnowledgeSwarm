import { config } from '../config';
import { STUB_SEARCH_RESULTS } from '../stubs/fixtures';
import type { SearchResult } from '../types';

export async function search(query: string): Promise<SearchResult[]> {
  if (config.stubMode) {
    console.log(`  [search] stub: "${query}"`);
    return STUB_SEARCH_RESULTS;
  }
  const res = await fetch(`${config.apiBaseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    console.error(`[search] failed: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { results?: SearchResult[]; error?: string };
  return data.results ?? [];
}
