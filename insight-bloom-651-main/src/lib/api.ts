const API_BASE = (import.meta.env as Record<string, string>).VITE_API_BASE_URL ?? 'http://localhost:8787';

export { API_BASE };

export async function checkAIStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/ai/status`);
    if (!res.ok) return false;
    const data = await res.json() as { configured: boolean };
    return data.configured;
  } catch {
    return false;
  }
}

export async function saveOpenAIKey(apiKey: string): Promise<void> {
  const res = await fetch(`${API_BASE}/ai/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, verify: true }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to save API key');
  }
  localStorage.setItem('openai_configured', 'true');
}

export async function createRun(prompt: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt.slice(0, 200) || 'Knowledge graph' }),
  });
  if (!res.ok) throw new Error('Failed to create run');
  const data = await res.json() as { runId: string };
  return data.runId;
}

export function openRunStream(runId: string): EventSource {
  return new EventSource(`${API_BASE}/runs/${runId}/events`);
}

export async function swarmExtractFromText(
  runId: string,
  text: string,
  documentName = 'input',
): Promise<void> {
  const res = await fetch(`${API_BASE}/ai/runs/${runId}/swarm-extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, documentName }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Swarm extraction failed');
  }
}

export async function extractFromText(
  runId: string,
  text: string,
  documentName = 'input',
): Promise<void> {
  try {
    await swarmExtractFromText(runId, text, documentName);
    return;
  } catch (error) {
    console.warn('Swarm extraction failed; falling back to generic extraction', error);
  }

  const res = await fetch(`${API_BASE}/ai/runs/${runId}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, documentName, chunkSize: 500, overlap: 50 }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Extraction failed');
  }
}

export async function extractFromFile(runId: string, file: File): Promise<void> {
  const text = await file.text();
  return extractFromText(runId, text, file.name);
}

export async function checkMcpHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/mcp/health`);
    if (!res.ok) return false;
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function mcpListDirectory(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}/mcp/list-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error('Failed to list MCP directory');
  const data = await res.json() as { content?: Array<{ text: string }> };
  return data.content?.map(c => c.text).join('\n') ?? '';
}

export async function mcpReadFile(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}/mcp/read-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to read file: ${path}`);
  const data = await res.json() as { content?: Array<{ text: string }> };
  return data.content?.map(c => c.text).join('') ?? '';
}

export const MCP_CONNECTOR_URL = `${API_BASE}/downloads/knowledge-swarm-connector.zip`;

export interface SubtreeNode {
  id: string;
  label: string;
  type?: string;
}

export interface SubtreeEdge {
  subjectLabel: string;
  predicate: string;
  objectLabel: string;
}

export interface ExpandContext {
  parentNode?: SubtreeNode;
  siblings?: string[];
  graphDepth?: number;
  globalBranches?: string[];
}

export async function expandSubtree(
  runId: string,
  rootNode: SubtreeNode,
  nodes: SubtreeNode[],
  edges: SubtreeEdge[],
  question?: string,
  ctx?: ExpandContext,
): Promise<{ summary: string; newTriplesPersisted: number }> {
  const res = await fetch(`${API_BASE}/ai/runs/${runId}/expand-subtree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootNode, nodes, edges, question, ...ctx }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Expansion failed');
  }
  return res.json() as Promise<{ summary: string; newTriplesPersisted: number }>;
}
