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

export interface NodeCategory {
  label: string;
  nodeIds: string[];
}

export async function categorizeNodes(
  nodes: Array<{ id: string; label: string; type: string }>,
): Promise<NodeCategory[]> {
  try {
    const res = await fetch(`${API_BASE}/ai/categorize-nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { categories: NodeCategory[] };
    return data.categories ?? [];
  } catch {
    return [];
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
    const res = await fetch(`${API_BASE}/ai/describe-node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, entityType, relationships }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { description: string | null };
    return data.description ?? null;
  } catch {
    return null;
  }
}

export async function extractFromFile(runId: string, file: File): Promise<void> {
  const text = await file.text();
  return extractFromText(runId, text, file.name);
}

export async function checkMcpHealth(mcpServerUrl?: string): Promise<{ ok: boolean; error?: string; mcpServerUrl?: string }> {
  try {
    const res = await fetch(`${API_BASE}/mcp/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServerUrl }),
    });
    const data = await res.json() as { ok: boolean; error?: string; mcpServerUrl?: string };
    return { ok: data.ok === true, error: data.error, mcpServerUrl: data.mcpServerUrl };
  } catch {
    return { ok: false, error: 'Failed to reach backend API. Make sure the backend is running.' };
  }
}

// Test MCP server directly from frontend (bypasses backend)
export async function checkMcpHealthDirect(mcpServerUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    let response = await fetch(`${mcpServerUrl}/health`);
    if (!response.ok) {
      response = await fetch(`${mcpServerUrl}/tools/list`);
    }
    return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
  } catch {
    return { ok: false, error: 'Cannot reach MCP server. Make sure the URL is correct and CORS is enabled.' };
  }
}

export async function mcpListDirectory(path: string, mcpServerUrl?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/mcp/list-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, mcpServerUrl }),
  });
  if (!res.ok) throw new Error('Failed to list MCP directory');
  const data = await res.json() as { content?: Array<{ text: string }> };
  return data.content?.map(c => c.text).join('\n') ?? '';
}

export async function mcpReadFile(path: string, mcpServerUrl?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/mcp/read-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, mcpServerUrl }),
  });
  if (!res.ok) throw new Error(`Failed to read file: ${path}`);
  const data = await res.json() as { content?: Array<{ text: string }> };
  return data.content?.map(c => c.text).join('') ?? '';
}

export const MCP_CONNECTOR_URL = `${API_BASE}/downloads/knowledge-swarm-connector.zip`;

interface McpReadAllResponse {
  content?: Array<{ text: string }>;
}

export async function mcpReadAll(mcpServerUrl?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/mcp/read-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpServerUrl }),
  });
  if (!res.ok) {
    const errorData = await res.json() as { error?: string };
    throw new Error(errorData.error ?? 'Failed to read files from MCP server');
  }
  const data = await res.json() as McpReadAllResponse;
  return data.content?.map(c => c.text).join('\n\n') ?? '';
}

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
