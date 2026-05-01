const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? 'http://localhost:8787';

async function extractPdfViaBackend(file: File): Promise<string> {
  // btoa on large files risks stack overflow — use FileReader for safety
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  const res = await fetch(`${API_BASE}/ai/pdf-to-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf: base64 }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `PDF extraction failed (${res.status})`);
  }

  const { text } = await res.json() as { text: string };
  return text;
}

export async function extractFileText(file: File): Promise<string> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractPdfViaBackend(file);
  }
  return file.text();
}
