# Frontend AI Integration Guide

Base URL: `http://localhost:8786` (dev) — replace with deployed URL in prod.

---

## 1. API Key Setup (Security-First)

**Never hardcode the OpenAI key in frontend code or ship it in a build.**

The user enters their key once per session in a settings modal. The frontend sends it to the backend, which stores it in memory. It never travels back to the browser after that.

### Settings modal — on save:

```ts
async function saveOpenAIKey(apiKey: string) {
  const res = await fetch(`${API_BASE}/ai/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, verify: true }), // verify: true checks the key against OpenAI
  });

  const data = await res.json();
  if (!res.ok) {
    // Show error: data.error (e.g. "OpenAI rejected the key")
    throw new Error(data.error);
  }
  // Store only a boolean flag locally — never the key itself
  localStorage.setItem('openai_configured', 'true');
}
```

### On app load — check if key is already set:

```ts
const res = await fetch(`${API_BASE}/ai/status`);
const { configured } = await res.json();
if (!configured) {
  // Show the settings modal / onboarding step
}
```

### Health check — shows all integration status:

```ts
GET /health
// { ok, service, integrations: { supabase, search, mcp, openai } }
```

Show a status bar in the UI using this. If `openai: false`, block the expand button and show "Add API key in settings".

---

## 2. SSE — Live Graph Updates

Open one SSE connection per run. Every node, edge, and agent progress event streams through it.

```ts
function openRunStream(runId: string) {
  const source = new EventSource(`${API_BASE}/runs/${runId}/events`);

  source.addEventListener('node.created', (e) => {
    const { node } = JSON.parse(e.data).payload;
    // node: { id, label, type, properties }
    addOrUpdateNode(node); // add to React Flow state
  });

  source.addEventListener('edge.created', (e) => {
    const { edge } = JSON.parse(e.data).payload;
    // edge: { source, target, predicate, confidence }
    addOrUpdateEdge(edge); // add to React Flow state
  });

  source.addEventListener('agent.step', (e) => {
    const { agentName, eventType, message } = JSON.parse(e.data).payload;
    // Show in a sidebar activity log or toast
    // eventTypes to handle:
    //   expansion.started   → show spinner on the clicked node
    //   expansion.searched  → "Searched web: X results"
    //   expansion.completed → hide spinner, flash new nodes
    //   extraction.started  → show progress bar
    //   extraction.chunk.done → increment progress bar
    //   extraction.completed  → hide progress bar
  });

  source.onerror = () => {
    // SSE auto-reconnects. Optionally show a "reconnecting..." badge.
  };

  return source; // call source.close() when navigating away
}
```

---

## 3. Document Upload → Extract to Graph

```ts
async function uploadAndExtract(runId: string, file: File) {
  const text = await file.text(); // works for .txt, .md, .csv

  const res = await fetch(`${API_BASE}/ai/runs/${runId}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      documentName: file.name,
      chunkSize: 500,
      overlap: 50,
    }),
  });

  const data = await res.json();
  // { ok, chunksProcessed, triplesExtracted, errors }
  // New nodes/edges arrive via SSE — no need to parse this response for graph updates
}
```

For PDF: use a library like `pdfjs-dist` to extract the text first, then send the same payload.

---

## 4. Node Click → Expand Subtree (The Main AI Feature)

When the user clicks a node or branch, collect the subtree from React Flow state and POST it.

```ts
async function expandBranch(
  runId: string,
  rootNodeId: string,
  question?: string
) {
  // Pull the subtree from your React Flow graph state
  const subtreeNodes = getSubtreeNodes(rootNodeId);   // your own helper
  const subtreeEdges = getSubtreeEdges(subtreeNodes);  // your own helper

  const res = await fetch(`${API_BASE}/ai/runs/${runId}/expand-subtree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootNode: {
        id: rootNodeId,
        label: subtreeNodes[0].data.label,
        type: subtreeNodes[0].data.type ?? 'Entity',
      },
      nodes: subtreeNodes.slice(1).map(n => ({
        id: n.id,
        label: n.data.label,
        type: n.data.type ?? 'Entity',
      })),
      edges: subtreeEdges.map(e => ({
        subjectLabel: getNodeLabel(e.source),
        predicate: e.label ?? e.data?.predicate ?? 'related_to',
        objectLabel: getNodeLabel(e.target),
      })),
      question: question ?? undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    // Show error toast: err.error
    // Common: "OpenAI API key not configured" → open settings modal
    return;
  }

  const data = await res.json();
  // { ok, summary, newTriplesPersisted, searchQueries, searchResultCount }
  // New nodes/edges already arrived via SSE before this resolves.
  // Use data.summary to show in the node side panel.
}
```

### Recommended UX for the expand button:
1. User clicks a node → side panel opens showing node details
2. Optional: user types a question in the panel
3. User clicks **"Research & Expand"**
4. Button becomes a spinner (listen for `expansion.started` on SSE)
5. Side panel shows "Searching web..." (listen for `expansion.searched`)
6. New nodes animate onto the graph (SSE `node.created` / `edge.created`)
7. Side panel shows the AI summary from `data.summary`

---

## 5. React Flow State Helpers

These are the two helpers referenced above — implement them based on your React Flow `nodes` and `edges` state:

```ts
// Returns the root node + all nodes reachable from it (BFS)
function getSubtreeNodes(rootId: string): Node[] {
  const visited = new Set<string>();
  const queue = [rootId];
  const result: Node[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.find(n => n.id === id);
    if (node) result.push(node);
    edges
      .filter(e => e.source === id && !visited.has(e.target))
      .forEach(e => queue.push(e.target));
  }
  return result;
}

// Returns all edges where both endpoints are in the subtree
function getSubtreeEdges(subtreeNodes: Node[]): Edge[] {
  const ids = new Set(subtreeNodes.map(n => n.id));
  return edges.filter(e => ids.has(e.source) && ids.has(e.target));
}

function getNodeLabel(nodeId: string): string {
  return nodes.find(n => n.id === nodeId)?.data?.label ?? nodeId;
}
```

---

## 6. Security Checklist

| Rule | Why |
|------|-----|
| Never store the OpenAI key in `localStorage`, React state, or component props | It would be readable by any JS on the page |
| Only store `openai_configured: true` locally | Enough to know whether to show the settings modal |
| All AI calls go through your backend (`/ai/*`) — never call OpenAI directly from the browser | Keeps the key server-side and lets you add rate limiting later |
| The backend `.env` is never committed to git | Add `apps/api/.env` to `.gitignore` |
| Add your Lovable/frontend origin to `CORS_ORIGINS` in `.env` | Prevents other sites from calling your API |
| On logout or session end, call `POST /ai/key` with an empty/invalid key to clear it | The runtime key lives in server memory; clearing it revokes access without a restart |

---

## 7. Error States to Handle

| HTTP status | `error` field | What to show |
|-------------|---------------|--------------|
| `503` | `OpenAI API key not configured` | Open the settings modal |
| `503` | `No web search results returned` | "Search is not configured — ask the admin to add a Brave API key" |
| `400` | `Invalid input` | Log to console, show generic error toast |
| `500` | Any | "Something went wrong, try again" |
