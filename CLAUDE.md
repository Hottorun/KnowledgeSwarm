# KnowledgeSwarm — CLAUDE.md

## Project Overview

KnowledgeSwarm is a live knowledge graph builder. Users connect local data (files or MCP folder) and the system extracts entities/relationships into a React Flow graph in real time using a specialist AI swarm. Web search is a secondary, node-level-only expansion — never the primary data path.

---

## Monorepo Structure

```
KnowledgeSwarm/
├── apps/
│   ├── api/                  # Express backend (port 8787)
│   ├── orchestrator/         # Claude specialist swarm
│   └── mcp-bridge/           # HTTP bridge for MCP filesystem server (port 8790)
├── insight-bloom-651-main/   # React frontend (Bun + Vite + TanStack Start)
├── supabase/
│   └── migrations/0001_initial_schema.sql
├── docs/                     # API contract, runbooks, integration guides
├── scripts/
│   └── start-filesystem-mcp.sh
├── demo-data/knowledge-swarm-demo/
└── .env.example
```

---

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | TypeScript, Express 4, Zod, SSE, Supabase |
| Orchestrator | TypeScript, Claude API (`@anthropic-ai/sdk`), prompt caching |
| Frontend | React 19, Vite 7, TanStack Start, `@xyflow/react` v12, Tailwind CSS v4, Framer Motion, Radix UI / shadcn |
| MCP Bridge | TypeScript, Express, `@modelcontextprotocol/sdk` |
| Database | Supabase (Postgres + Realtime) |

---

## Data Flow (in order)

1. User connects MCP source or drag/drops files.
2. Frontend calls `POST /runs` → receives `runId`.
3. Frontend opens `GET /runs/:runId/events` with `EventSource` (SSE).
4. Backend chunks uploaded text via `POST /runs/:runId/uploads/text` → returns chunks.
5. Orchestrator (specialist swarm) reads chunks → extracts SPO triples → calls `POST /runs/:runId/raw-triples`.
6. Backend normalizes triples → persists to Supabase → streams `node.created`, `edge.created`, `source.created` events over SSE.
7. Frontend upserts React Flow nodes/edges as events arrive, runs force-directed auto-layout.
8. User clicks a node → side panel opens with details and a question box.
9. Node Q&A: orchestrator expander answers from graph/files first. Web search (`POST /search`) only if local data insufficient.

**SSE = live UI path. `/raw-triples` = graph ingestion path. Web search = node-level expansion only.**

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
| POST | `/runs/:runId/triples` | Fully-formed typed triples (orchestrator structured output) |
| POST | `/runs/:runId/extract` | Trigger AI extraction on run |
| POST | `/ai/key` | Set OpenAI API key at runtime |
| GET | `/ai/status` | AI availability status |
| POST | `/search` | Web search via Tavily or Brave (node-level expansion only) |
| GET | `/downloads/knowledge-swarm-connector.zip` | Local MCP connector bundle |
| GET | `/mcp/health` | Check if MCP bridge is reachable |
| GET | `/mcp/tools` | List available MCP bridge tools |
| POST | `/mcp/list-directory` | List a directory via MCP bridge |
| POST | `/mcp/read-file` | Read a file via MCP bridge |
| POST | `/mcp/search-files` | Search files via MCP bridge |

---

## SSE Event Stream

Open with `EventSource`. No auth required for local dev.

### Event envelope

```ts
type StreamEvent<TPayload> = {
  type: string;
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

## Orchestrator — Specialist Swarm

**Location:** `apps/orchestrator/`

**Architecture:**

```
MetaAgent (claude-sonnet-4-6)
  → Decomposes document into 3-5 independent branches (e.g. "Finances", "Executives")
    ↓
    Branch 1 → Specialist Agent (assigned profile)
      → Supervisor (claude-haiku-4-5) + Workers (claude-haiku-4-5)
      → Workers extract SPO triples per chunk
      → Supervisor filters low-quality triples
    ↓
    Branch 2, 3 … (parallel)
  ↓
Normalize & deduplicate across branches
  ↓
POST /runs/:runId/raw-triples → SSE → frontend
```

**Models used:**

| Agent | Model |
|-------|-------|
| MetaAgent | claude-sonnet-4-6 |
| Supervisor | claude-haiku-4-5-20251001 |
| Worker | claude-haiku-4-5-20251001 |
| Expander | claude-haiku-4-5-20251001 |

**Prompt caching** is enabled for repeated chunk processing.

**Stub mode:** `npm run stub` or `ORCHESTRATOR_STUB_MODE=true` — runs without real API calls using fixture data.

**Chunk config:** 600 words per chunk, 80 word overlap, 2000 char meta summary.

---

## Frontend

**Location:** `insight-bloom-651-main/`
**Package manager:** Bun
**Dev command:** `bun run dev`

### Key Components

| File | Purpose |
|------|---------|
| `src/routes/index.tsx` | Single-page knowledge graph interface |
| `src/components/knowledge-graph/KnowledgeGraphCanvas.tsx` | Main orchestrator (state, SSE, layout, events) |
| `src/components/knowledge-graph/GraphNode.tsx` | Node renderer |
| `src/components/knowledge-graph/SidePanel.tsx` | Left (TOC) & Right (Reasoning) drawers |
| `src/components/knowledge-graph/NodeInputBox.tsx` | Node action popup |
| `src/components/knowledge-graph/FloatingEdge.tsx` | Custom edge renderer |
| `src/components/knowledge-graph/TopNav.tsx` | Header |
| `src/components/knowledge-graph/AnimatedBlob.tsx` | Landing/loading blob |

### Layout Engine

Force-directed layout: Coulomb repulsion + Hooke springs + AABB collision resolution. Auto `fitView` after each layout pass.

### React Flow Mapping

```ts
// Backend node → React Flow node
{ id: node.id, type: 'default', position: { x: 0, y: 0 },
  data: { label: node.label, entityType: node.type, properties: node.properties } }

// Backend edge → React Flow edge
{ id: `${edge.source}:${edge.predicate}:${edge.target}`,
  source: edge.source, target: edge.target,
  label: edge.predicate, data: { confidence: edge.confidence } }
```

Upsert by id — the same entity may arrive multiple times across chunks.

---

## Database Schema (Supabase)

| Table | Purpose |
|-------|---------|
| `research_runs` | Run metadata (prompt, status, timestamps) |
| `graph_nodes` | Entities — composite PK (run_id, id) |
| `graph_edges` | Relationships (source, target, predicate, confidence 0–1) |
| `sources` | External references (URL, title, snippet) |
| `edge_sources` | Many-to-many join: edges ↔ sources |
| `agent_events` | Agent reasoning/progress events |

Supabase Realtime is enabled. Foreign keys cascade on run deletion.

---

## Environment Variables

```env
# Backend (apps/api)
PORT=8787
CORS_ORIGINS=http://localhost:3000,...
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TAVILY_API_KEY=           # OR BRAVE_SEARCH_API_KEY
BRAVE_SEARCH_API_KEY=
SEARCH_MAX_RESULTS=5
MCP_SERVER_URL=http://localhost:8790
MCP_FILESYSTEM_ROOTS=/path/to/demo/files
ANTHROPIC_API_KEY=
OPENAI_API_KEY=           # Optional — node Q&A
SWARM_ORCHESTRATOR_CWD=
SWARM_TIMEOUT_MS=120000
ORCHESTRATOR_STUB_MODE=false
```

Frontend: `VITE_API_BASE_URL` (defaults to `http://localhost:8787` for local dev).

---

## MCP Connector

Local filesystem MCP server speaks stdio, not HTTP. A local bridge wraps it:

```
filesystem MCP (stdio) → HTTP bridge :8790 → backend MCP_SERVER_URL
```

Start bridge: `bash scripts/start-filesystem-mcp.sh /path/to/folder`

**For hackathon demo, drag/drop upload is the guaranteed path.** MCP is shown as an option with setup instructions.

Download bundle: `GET /downloads/knowledge-swarm-connector.zip` → `connector.js`, `start-mac-linux.sh`, `start-windows.ps1`, `README.txt`.

---

## Node ID Conventions

```
company:acme-corp
person:jane-doe
document:annual-report-2025
market:lithium-batteries
```

Stable, lowercase, hyphenated slugs prefixed by entity type.

---

## File Upload (Drag/Drop)

Supported: `.txt`, `.md`, `.csv`, `.json` (PDF/Excel parsing exists, integration in progress)

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

Response returns chunks. Orchestrator consumes those chunks and calls `/raw-triples`.

---

## `/raw-triples` — Graph Ingestion

Used by orchestrator. Backend handles normalization and ID generation.

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

Prefer `/raw-triples` over `/triples` when the extraction layer only has raw strings (no pre-built node IDs).

---

## UI States

| State | Description |
|-------|-------------|
| Empty | Prompt input + disabled graph canvas + animated blob |
| Running | Graph canvas + agent activity panel (live SSE) |
| Error | Failed backend call or SSE disconnect message |
| Completed | Interactive graph + source list |

Node click → side panel with: label, entity type, properties, source snippets, question input for node-level AI/web research. AI-expanded nodes get a badge.

---

## Developer Responsibilities

| Dev | Owns |
|-----|------|
| Dev 1 | Backend API (`apps/api`), Supabase infra, MCP bridge, SSE, search integration |
| Dev 2 | Orchestrator (`apps/orchestrator`): chunking, LLM extraction → raw triples, node Q&A (graph-first then search) |
| Dev 3 | Frontend (`insight-bloom-651-main`): MCP instructions panel, drag/drop upload, SSE → React Flow, node detail panel |

---

## Implementation Status

**Complete:**
- Backend API with SSE streaming
- Supabase schema and Realtime
- Specialist swarm orchestrator (Claude API with agents, prompt caching)
- Text chunking and triple normalization
- MCP HTTP bridge wrapper
- Frontend React Flow visualization (force-directed layout)
- Graph search panel, undo/redo, node deletion
- Node expansion with AI (expander agent)
- Drag/drop file upload path
- Web search integration (Tavily/Brave)
- AI badge on AI-expanded nodes

**In Progress:**
- PDF/Excel file parsing refinement
- Node-level Q&A completion
- MCP connector user education panel
- End-to-end demo script

---

## Ingestion-First Principle

The graph is built from user-provided data first. Web research expands individual nodes on demand. KnowledgeSwarm is a knowledge base built from user files — not a web research tool with a graph visualization.
