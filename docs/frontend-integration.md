# Frontend Integration Guide

This guide is for Developer 3 and the Lovable/Claude frontend work.

## Goal

Render a live knowledge graph from user-provided files/MCP content first, then let the user expand selected nodes with AI/web research. The frontend should let a user connect data, upload files, start ingestion, open a live event stream, and add/update React Flow nodes and edges as extraction results arrive.

## Backend Base URL

Use an environment variable in the Lovable app:

```bash
VITE_API_BASE_URL=http://localhost:8787
```

When deployed, replace it with the hosted API URL.

## Required Flow

1. User connects an MCP data source or uploads files.
2. Frontend calls `POST /runs`.
3. Backend returns `runId`.
4. Frontend opens `GET /runs/:runId/events` with `EventSource`.
5. Orchestrator parses files/MCP content and posts graph triples.
6. Frontend renders incoming `node.created`, `edge.created`, `source.created`, and `agent.step` events.
7. User clicks a node and asks a node-specific question.
8. Orchestrator answers from files/graph first, then researches online if needed.

## Drag/Drop Upload

For the first working demo, support text-like files in the browser:

- `.txt`
- `.md`
- `.csv`
- `.json`

Read them with `File.text()`, then call:

```ts
await fetch(`${API_BASE_URL}/runs/${runId}/uploads/text`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    files: await Promise.all(files.map(async (file) => ({
      name: file.name,
      mimeType: file.type || 'text/plain',
      content: await file.text(),
    }))),
    chunkSize: 500,
    overlap: 50,
  }),
});
```

The response returns document chunks. Developer 2's extraction layer should turn those chunks into raw SPO triples and call `/runs/:runId/raw-triples`.

## MCP Connector Download

The frontend can expose:

```ts
const connectorUrl = `${API_BASE_URL}/downloads/knowledge-swarm-connector.zip`;
```

User flow:

1. Click "Download local connector".
2. Unzip.
3. Run `start-mac-linux.sh /path/to/folder` or `start-windows.ps1`.
4. Keep connector URL as `http://localhost:8790`.
5. Check `GET http://localhost:8790/health`.

## Create A Run

Request:

```ts
const response = await fetch(`${API_BASE_URL}/runs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt }),
});

const { runId } = await response.json();
```

## Open SSE Stream

```ts
const events = new EventSource(`${API_BASE_URL}/runs/${runId}/events`);

events.addEventListener('run.status', (event) => {
  const message = JSON.parse(event.data);
  // message = { type, runId, timestamp, payload }
});

events.addEventListener('agent.step', (event) => {
  const message = JSON.parse(event.data);
  appendAgentEvent(message.payload);
});

events.addEventListener('node.created', (event) => {
  const message = JSON.parse(event.data);
  upsertGraphNode(message.payload.node);
});

events.addEventListener('edge.created', (event) => {
  const message = JSON.parse(event.data);
  upsertGraphEdge(message.payload.edge);
});

events.addEventListener('source.created', (event) => {
  const message = JSON.parse(event.data);
  appendSource(message.payload.source);
});

events.onerror = () => {
  // Show reconnecting state. EventSource retries automatically.
};
```

## Event Envelope

Every SSE message uses this shape:

```ts
type StreamEvent<TPayload> = {
  type: string;
  runId: string;
  timestamp: string;
  payload: TPayload;
};
```

## Graph Payloads

Node event:

```json
{
  "type": "node.created",
  "runId": "uuid",
  "timestamp": "2026-04-30T12:00:00.000Z",
  "payload": {
    "node": {
      "id": "company:acme",
      "label": "Acme Corp",
      "type": "Company",
      "properties": {}
    }
  }
}
```

Edge event:

```json
{
  "type": "edge.created",
  "runId": "uuid",
  "timestamp": "2026-04-30T12:00:00.000Z",
  "payload": {
    "edge": {
      "source": "company:acme",
      "target": "company:beta",
      "predicate": "acquired",
      "confidence": 0.84
    }
  }
}
```

## React Flow Mapping

Backend node to React Flow node:

```ts
function toReactFlowNode(node: GraphNode): Node {
  return {
    id: node.id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: {
      label: node.label,
      entityType: node.type,
      properties: node.properties,
    },
  };
}
```

Backend edge to React Flow edge:

```ts
function toReactFlowEdge(edge: GraphEdge): Edge {
  return {
    id: `${edge.source}:${edge.predicate}:${edge.target}`,
    source: edge.source,
    target: edge.target,
    label: edge.predicate,
    data: {
      confidence: edge.confidence,
    },
  };
}
```

Use an upsert strategy. Agents may mention the same entity more than once.

## Suggested UI States

- Empty state: prompt input and disabled graph canvas.
- Running state: graph canvas plus agent activity panel.
- Error state: show failed backend call or SSE disconnect.
- Completed state: keep graph interactive and show source list.

## Layout

Use an auto-layout pass whenever new nodes or edges arrive. Good options:

- `dagre`
- `elkjs`

For hackathon speed, `dagre` is usually enough.

## Claude Prompt For Developer 3

You are implementing the Lovable React/TypeScript frontend for KnowledgeSwarm. The backend exposes `POST /runs` plus `GET /runs/:runId/events` over Server-Sent Events. Build a usable first screen: MCP connection instructions, drag/drop file upload, start ingestion button, live React Flow graph, agent activity panel, source panel, and a node detail/question side panel.

Use `VITE_API_BASE_URL` for the backend URL. When ingestion starts, call `POST /runs`, store the returned `runId`, open an `EventSource` to `/runs/:runId/events`, and handle these event names: `run.status`, `agent.step`, `node.created`, `edge.created`, `source.created`, `error`.

Every event data payload is JSON with `{ type, runId, timestamp, payload }`. Map `payload.node` to React Flow nodes and `payload.edge` to React Flow edges. Upsert nodes by `id`; upsert edges by deterministic ID `${source}:${predicate}:${target}`. Run auto-layout after graph changes using dagre or elkjs. Keep the UI dense and operational, not a marketing landing page.

Do not hardcode sample graph data as the primary path. Use real backend events, but you may include a small local fallback demo mode if the API is unavailable. Node clicks should open a panel with label, entity type, properties, source snippets, and a question input for asking the AI to research or explain that specific node.
