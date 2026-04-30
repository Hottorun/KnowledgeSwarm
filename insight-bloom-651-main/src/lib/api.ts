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

export async function createRun(): Promise<string> {
  const res = await fetch(`${API_BASE}/runs`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create run');
  const data = await res.json() as { runId: string };
  return data.runId;
}

export function openRunStream(runId: string): EventSource {
  return new EventSource(`${API_BASE}/runs/${runId}/events`);
}

export async function extractFromText(
  runId: string,
  text: string,
  documentName = 'input',
): Promise<void> {
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

export async function expandSubtree(
  runId: string,
  rootNode: SubtreeNode,
  nodes: SubtreeNode[],
  edges: SubtreeEdge[],
  question?: string,
): Promise<{ summary: string; newTriplesPersisted: number }> {
  const res = await fetch(`${API_BASE}/ai/runs/${runId}/expand-subtree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootNode, nodes, edges, question }),
  });
  if (!res.ok) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? 'Expansion failed');
  }
  return res.json() as Promise<{ summary: string; newTriplesPersisted: number }>;
}
