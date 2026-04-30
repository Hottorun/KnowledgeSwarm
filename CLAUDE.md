# KnowledgeSwarm — CLAUDE.md

## Project Overview

KnowledgeSwarm is a live knowledge graph builder. Users connect local data (files or MCP folder) and the system extracts entities/relationships into a React Flow graph in real time. Web search is a secondary, node-level-only expansion — never the primary data path.

## Backend Base URL

```
http://localhost:8787        # local dev
VITE_API_BASE_URL            # frontend env var — replace with hosted URL when deployed
```

---

## Data Flow (in order)

1. User connects MCP source or drag/drops files.
2. Frontend calls `POST /runs` → receives `runId`.
3. Frontend opens `GET /runs/:runId/events` with `EventSource` (SSE).
4. Orchestrator (Dev 2) reads files/MCP content, chunks text, extracts SPO triples, calls `POST /runs/:runId/raw-triples`.
5. Backend normalizes triples → streams `node.created`, `edge.created`, `source.created` events over SSE.
6. Frontend upserts React Flow nodes/edges as events arrive, runs auto-layout (dagre/elkjs).
7. User clicks a node → side panel opens with details and a question box.
8. Orchestrator answers from graph/files first. Web search (`POST /search`) is called only if local data is insufficient.

**SSE = live UI path. `/raw-triples` = graph ingestion path. Web search = node-level expansion only, after local data is parsed.**

---

## Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Backend + integration status |
| POST | `/runs` | Create a research run, returns `runId` |
| GET | `/runs/:runId/events` | SSE stream — live graph + agent events |
| POST | `/runs/:runId/agent-events` | Orchestrator posts progress/reasoning |
| POST | `/runs/:runId/uploads/text` | Browser drag/drop: send file text, get chunks back |
| POST | `/runs/:runId/chunks` | Raw text → overlapping chunks |
| POST | `/runs/:runId/raw-triples` | String-based SPO triples → normalized graph nodes/edges |
| POST | `/runs/:runId/triples` | Fully-formed typed triples (used by orchestrator for structured output) |
| POST | `/search` | Web search via Tavily or Brave (node-level expansion only) |
| GET | `/downloads/knowledge-swarm-connector.zip` | Local MCP connector bundle |
| GET | `/mcp/health` | Check if MCP bridge is reachable |
| GET | `/mcp/tools` | List available MCP bridge tools |
| POST | `/mcp/list-directory` | List a directory via MCP bridge |
| POST | `/mcp/read-file` | Read a file via MCP bridge |
| POST | `/mcp/search-files` | Search files via MCP bridge |

---

## SSE Event Stream

Open with `EventSource`, no auth required for local dev.

### Event envelope (every event)

```ts
type StreamEvent<TPayload> = {
  type: string;   // see event types below
  runId: string;
  timestamp: string; // ISO 8601
  payload: TPayload;
};
```

### Event types

- `run.created` / `run.started` / `run.completed` / `run.failed`
- `agent.step` — orchestrator reasoning/progress
- `node.created` — new graph node
- `edge.created` — new graph edge
- `source.created` — new source reference
- `error`

Server sends `: heartbeat` comment every 15 seconds. `EventSource` auto-reconnects on disconnect.

### Graph payloads

**node.created payload.node:**
```json
{ "id": "company:acme", "label": "Acme Corp", "type": "Company", "properties": {} }
```

**edge.created payload.edge:**
```json
{ "source": "company:acme", "target": "company:beta", "predicate": "acquired", "confidence": 0.84 }
```

---

## React Flow Mapping

```ts
// Backend node → React Flow node
{ id: node.id, type: 'default', position: { x: 0, y: 0 },
  data: { label: node.label, entityType: node.type, properties: node.properties } }

// Backend edge → React Flow edge
{ id: `${edge.source}:${edge.predicate}:${edge.target}`,
  source: edge.source, target: edge.target,
  label: edge.predicate, data: { confidence: edge.confidence } }
```

- **Upsert by id** — the same entity may arrive multiple times across chunks.
- Run auto-layout (dagre preferred for hackathon) after each batch of changes.

---

## File Upload (Drag/Drop)

Supported file types: `.txt`, `.md`, `.csv`, `.json`

```ts
await fetch(`${API_BASE_URL}/runs/${runId}/uploads/text`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    files: await Promise.all(files.map(async (f) => ({
      name: f.name,
      mimeType: f.type || 'text/plain',
      content: await f.text(),
    }))),
    chunkSize: 500,
    overlap: 50,
  }),
});
```

Response returns document chunks. Dev 2's extraction layer consumes those chunks and calls `/raw-triples`.

---

## `/raw-triples` — Graph Ingestion Path

Used by the orchestrator (Dev 2). Accepts simple string-based SPO triples; backend handles normalization and ID generation.

```json
{
  "agentName": "IngestionAgent",
  "triples": [{
    "subject": "Acme Corp",
    "predicate": "acquired",
    "object": "Beta Inc",
    "subjectType": "Company",
    "objectType": "Company",
    "confidence": 0.84,
    "source": { "documentName": "acquisitions.pdf", "page": 3, "snippet": "..." },
    "properties": { "date": "2026-04-01" }
  }]
}
```

Use this over `/triples` when the extraction layer only has raw strings (no pre-built node IDs).

---

## Node ID Conventions (Orchestrator)

```
company:acme
person:jane-doe
document:annual-report-2025
market:lithium-batteries
```

Stable, lowercase, hyphenated slugs by entity type.

---

## Web Search — Node-Level Expansion Only

- Endpoint: `POST /search`
- Called by orchestrator only after graph/file data is insufficient for a node question.
- Never used as the primary ingestion path.
- Requires `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` in backend env. Returns `503` if unconfigured.

---

## MCP Connector

Local filesystem MCP server speaks stdio, not HTTP. A local bridge process wraps it:

```
filesystem MCP (stdio) → local HTTP bridge :8790 → backend MCP_SERVER_URL
```

For the hackathon demo, **drag/drop upload is the guaranteed path**. MCP connector is shown as an option with instructions.

### Download bundle

`GET /downloads/knowledge-swarm-connector.zip` contains `connector.js`, `start-mac-linux.sh`, `start-windows.ps1`, `README.txt`.

User runs: `bash scripts/start-filesystem-mcp.sh /path/to/folder` → bridge at `http://localhost:8790`.

Backend env: `MCP_SERVER_URL=http://localhost:8790`

---

## UI States

| State | Description |
|-------|-------------|
| Empty | Prompt input + disabled graph canvas |
| Running | Graph canvas + agent activity panel (live SSE) |
| Error | Failed backend call or SSE disconnect message |
| Completed | Interactive graph + source list |

Node click → side panel with: label, entity type, properties, source snippets, question input for node-level AI/web research.

---

## Developer Responsibilities

| Dev | Owns |
|-----|------|
| Dev 1 | Local MCP bridge or fallback upload path; backend infra |
| Dev 2 | Orchestrator: chunking, LLM extraction → raw triples, node Q&A (graph-first then search) |
| Dev 3 | Frontend: MCP instructions panel, drag/drop upload, SSE → React Flow, node detail panel |

---

## Ingestion-First Principle

The graph is built from user-provided data first. Web research expands individual nodes on demand. The system is a knowledge base from user files, not a web research tool with a graph visualization.
