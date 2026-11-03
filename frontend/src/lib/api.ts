const API_BASE = (import.meta.env as Record<string, string>).VITE_API_BASE_URL ?? 'http://localhost:8787';

export { API_BASE };

/**
 * The public demo build replays a prepared graph instead of calling the
 * backend (see demo.ts), so it never reaches Claude or web search.
 */
export const DEMO = (import.meta.env as Record<string, string>).VITE_DEMO === 'true';
let demoModule: typeof import('./demo') | null = null;
const demo = async () => (demoModule ??= await import('./demo'));

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectDocument {
  id: string;
  project_id: string;
  name: string;
  mime_type: string | null;
  char_count: number;
  created_at: string;
}

export interface ProjectMap {
  id: string;
  project_id: string;
  run_id: string | null;
  name: string;
  prompt: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithDetails extends Project {
  documents: ProjectDocument[];
  maps: ProjectMap[];
}

export async function createProject(name: string): Promise<Project> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
  const res = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to create project');
  }
  return res.json() as Promise<Project>;
}

export async function listProjects(): Promise<Project[]> {
  if (DEMO) return [];
  const res = await fetch(`${API_BASE}/projects`);
  if (!res.ok) return [];
  return res.json() as Promise<Project[]>;
}

export async function getProject(projectId: string): Promise<ProjectWithDetails> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
  const res = await fetch(`${API_BASE}/projects/${projectId}`);
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to fetch project');
  }
  return res.json() as Promise<ProjectWithDetails>;
}

export async function uploadDocument(
  projectId: string,
  name: string,
  mimeType: string,
  rawText: string,
): Promise<ProjectDocument> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
  const res = await fetch(`${API_BASE}/projects/${projectId}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType, rawText }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to save document');
  }
  return res.json() as Promise<ProjectDocument>;
}

export async function deleteDocument(projectId: string, docId: string): Promise<void> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
  const res = await fetch(`${API_BASE}/projects/${projectId}/documents/${docId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to delete document');
  }
}

export async function generateMap(
  projectId: string,
  prompt: string,
  documentIds?: string[],
): Promise<{ mapId: string; runId: string }> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
  const res = await fetch(`${API_BASE}/projects/${projectId}/maps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, documentIds }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Failed to generate map');
  }
  return res.json() as Promise<{ mapId: string; runId: string }>;
}

export async function listMaps(projectId: string): Promise<ProjectMap[]> {
  if (DEMO) return [];
  const res = await fetch(`${API_BASE}/projects/${projectId}/maps`);
  if (!res.ok) return [];
  return res.json() as Promise<ProjectMap[]>;
}

export async function checkAIStatus(): Promise<boolean> {
  if (DEMO) return true;
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
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
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
  if (DEMO) return (await demo()).createRun();
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
  // createRun always runs first, so the demo module is already loaded here.
  if (DEMO && demoModule) return demoModule.openRunStream(runId);
  return new EventSource(`${API_BASE}/runs/${runId}/events`);
}

export async function swarmExtractFromText(
  runId: string,
  text: string,
  documentName = 'input',
): Promise<void> {
  if (DEMO) return (await demo()).extractFromText(runId);
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
  if (DEMO) return (await demo()).extractFromText(runId);
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
  if (DEMO) return (await demo()).categorizeNodes(nodes);
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

export interface NestLevel1Result {
  assignments: Array<{ entityId: string; categoryId: string; confidence: number; reason?: string }>;
  newTriplesPersisted: number;
}

export async function nestLevel1Entities(
  runId: string,
  categories: Array<{ id: string; label: string }>,
  entities: Array<{ id: string; label: string; type: string }>,
  mainEntityLabel?: string,
): Promise<NestLevel1Result> {
  if (DEMO) return (await demo()).nestLevel1Entities();
  const res = await fetch(`${API_BASE}/ai/runs/${runId}/nest-level1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categories, entities, mainEntityLabel }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Nest request failed (${res.status})`);
  }
  return res.json() as Promise<NestLevel1Result>;
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
  if (DEMO) return (await demo()).describeNode(label, entityType, relationships);
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
  if (DEMO) return { ok: false, error: (await demo()).NOT_IN_DEMO };
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
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
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
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
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
  files?: Array<{ name: string; text: string }>;
}

export async function mcpReadAll(mcpServerUrl?: string): Promise<string> {
  const files = await mcpReadAllFiles(mcpServerUrl);
  return files.map(file => `--- ${file.name} ---\n${file.text}`).join('\n\n');
}

export async function mcpReadAllFiles(mcpServerUrl?: string): Promise<Array<{ name: string; text: string }>> {
  if (DEMO) throw new Error((await demo()).NOT_IN_DEMO);
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
  if (Array.isArray(data.files) && data.files.length > 0) {
    return data.files.filter(file => file.name && file.text);
  }

  return (data.content ?? [])
    .map((entry, index) => {
      const match = entry.text.match(/^---\s+(.+?)\s+---\n?([\s\S]*)$/);
      return {
        name: match?.[1]?.trim() || `mcp-file-${index + 1}.txt`,
        text: match?.[2] ?? entry.text,
      };
    })
    .filter(file => file.text.trim());
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

export async function queryGraph(
  runId: string,
  question: string,
  nodes: SubtreeNode[],
  edges: SubtreeEdge[],
): Promise<{ answer: string; newTriplesPersisted: number; searchQueries: string[] }> {
  if (DEMO) return (await demo()).queryGraph(runId, question, nodes, edges);
  const res = await fetch(`${API_BASE}/ai/runs/${runId}/query-graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, nodes, edges }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Query failed');
  }
  return res.json() as Promise<{ answer: string; newTriplesPersisted: number; searchQueries: string[] }>;
}

export async function expandSubtree(
  runId: string,
  rootNode: SubtreeNode,
  nodes: SubtreeNode[],
  edges: SubtreeEdge[],
  question?: string,
  ctx?: ExpandContext,
): Promise<{ summary: string; newTriplesPersisted: number }> {
  if (DEMO) return (await demo()).expandSubtree(runId, rootNode, nodes, edges, question, ctx);
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
