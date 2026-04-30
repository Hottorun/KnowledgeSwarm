import { config, isSearchConfigured } from '../config';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export async function searchWithTavily(query: string): Promise<SearchResponse> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: config.searchMaxResults,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { results?: Array<Record<string, unknown>> };
  return {
    results: (data.results || []).map((r: Record<string, unknown>, i: number) => ({
      title: (r.title as string) || '',
      url: (r.url as string) || '',
      snippet: (r.content as string) || '',
      content: r.content as string | undefined,
      score: (r.score as number) || 1 - i * 0.1,
    })),
  };
}

export async function searchWithBrave(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, count: String(config.searchMaxResults) });
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': config.braveSearchApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
  return {
    results: (data.web?.results || []).map((r: Record<string, unknown>, i: number) => ({
      title: (r.title as string) || '',
      url: (r.url as string) || '',
      snippet: (r.description as string) || '',
      content: r.description as string | undefined,
      score: 1 - i * 0.1,
    })),
  };
}

export async function performSearch(query: string): Promise<SearchResponse> {
  const available = isSearchConfigured();

  if (available.tavily) {
    return searchWithTavily(query);
  }

  if (available.brave) {
    return searchWithBrave(query);
  }

  throw new Error('No search API key configured. Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY in .env');
}
