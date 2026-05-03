# KnowledgeSwarm Agent Notes

## Current Handoff: Sigma Main Renderer Migration

The latest active work is replacing the main graph rendering path with Sigma/Graphology because React Flow became unreliable for large graphs.

Current renderer state:

- `frontend/src/components/knowledge-graph/SigmaGraphView.tsx` is the new main renderer.
- `KnowledgeGraphCanvas.tsx` currently routes the graph canvas through Sigma.
- Frontend dependencies now include `sigma`, `graphology`, and `graphology-layout-forceatlas2`.
- Sigma keeps a persistent Graphology instance and mutates nodes/edges in place instead of recreating the whole graph every render.
- New nodes/edges use `animDelay` from the existing presentation/SSE layer so branches appear progressively.
- Layout is deterministic and branch-oriented: active/main node at center, category spokes, then document/entity/fact branches.
- Initial document submit creates a provisional center node immediately after `/runs` succeeds, then clears the blob while extraction continues streaming.
- Sigma has bottom-right zoom in, zoom out, and fit controls.
- Clicking Sigma nodes still calls the existing `handleNodeClick` path, so document panels, summaries, node expansion, and query focus should still work.
- `KnowledgeGraphRenderer.tsx` now owns the renderer boundary. `KnowledgeGraphCanvas.tsx` passes graph state and callbacks into it instead of importing Sigma rendering primitives directly.
- React Flow has been removed from the active frontend graph path.
- Sigma mode now always receives the raw graph nodes/edges and shows the whole graph. The smaller click-through presentation graph remains only for metadata and panel lookup.
- Sigma has explicit `focused` and `overview` modes. Overview uses smaller nodes, lower label density, muted edges, no staged insertion delay, and caps/prioritizes rendered edges for dense graphs.
- Sigma edge clicks open an in-renderer evidence panel showing source/target, predicate, confidence, source label, snippets, and clickable HTTP(S) source links when edge source data is present.
- Sigma nodes and edges set the canvas cursor to pointer on hover.

Important caution:

- React Flow imports, provider, minimap, camera calls, fallback rendering, and `@xyflow/react` have been removed from the frontend.
- The next cleanup is Sigma visual tuning and decomposing `KnowledgeGraphCanvas.tsx` into smaller hooks.
- `task.md` is the source of truth for current next tasks.

Validation so far:

- `npm run build` passes in `frontend`.
- Known non-blocking warning remains: Wrangler log EPERM in the sandbox.

This file is for future coding-agent sessions working in this repo. It captures the practical project knowledge, architecture, commands, and pitfalls learned during the hackathon build.

## Project Purpose

KnowledgeSwarm is a live knowledge graph builder for business/research data. A user uploads files or connects a local MCP data source. The backend/orchestrator extracts entities and relationships into subject-predicate-object triples, persists them, and streams graph updates to the frontend in real time.

Core product loop:

1. User uploads documents, pastes text, or connects an MCP filesystem source.
2. Backend creates a `research_run`.
3. Frontend opens an SSE stream for that run.
4. Orchestrator/specialist swarm extracts facts as triples.
5. API persists nodes, edges, sources, and agent events.
6. Frontend renders a Sigma.js graph progressively.
7. User clicks a node to inspect sources or ask follow-up questions.
8. Follow-up research expands around that node using graph/files first, web search second.

The app is data-ingestion-first. Web search is for node expansion, not the primary graph-building path.

## Repo Layout

```text
apps/api/                  Express API, SSE, Supabase persistence, search, MCP proxy
apps/orchestrator/         Claude specialist swarm and node expander
apps/mcp-bridge/           HTTP bridge around local MCP filesystem server
frontend/    React/TanStack/Vite frontend with Sigma graph
supabase/migrations/       Database schema
docs/                      API contracts and runbooks
scripts/                   Local helper scripts, including filesystem MCP startup
demo-data/                 Demo documents
CLAUDE.md                  Larger project handoff document
```

## Important Commands

Backend:

```bash
cd apps/api
npm install
npm run dev
```

Orchestrator:

```bash
cd apps/orchestrator
npm install
npm run build
npm run orchestrate
STUB_MODE=true node dist/index.js
```

Frontend:

```bash
cd frontend
bun install
bun run dev
npm run build
```

MCP filesystem bridge:

```bash
bash scripts/start-filesystem-mcp.sh /absolute/path/to/demo-folder
```

Use absolute paths for MCP roots. Paths with `~` caused issues.

## Main API Concepts

API base is normally `http://localhost:8787`.

Key endpoints:

```text
GET  /health
POST /runs
GET  /runs/:runId/events
POST /runs/:runId/agent-events
POST /runs/:runId/uploads/text
POST /runs/:runId/raw-triples
POST /runs/:runId/triples
POST /ai/runs/:runId/swarm-extract
POST /search
GET  /mcp/health
GET  /mcp/tools
POST /mcp/list-directory
POST /mcp/read-file
POST /mcp/search-files
```

SSE is the live UI path:

```text
GET /runs/:runId/events
```

The server keeps one HTTP connection open and pushes events like:

```text
agent.step
node.created
edge.created
source.created
run.completed
run.failed
```

This is simpler than WebSockets because the frontend only needs server-to-browser updates.

## Data Model

Everything becomes triples:

```text
subject - predicate - object
Acme Corp - acquired - Beta Inc
Jane Doe - leads - Operations Team
Warehouse A - supplies - Product X
```

Backend graph concepts:

```text
research_runs   run metadata
graph_nodes     entities
graph_edges     relationships
sources         file/web/source snippets
edge_sources    edge-to-source join
agent_events    reasoning/progress log
```

Node IDs should be stable lower-case slugs:

```text
company:acme-corp
person:jane-doe
document:annual-report-2025
market:lithium-batteries
```

Prefer `/raw-triples` if the AI returns strings. The API normalizes labels/types into graph nodes. Use `/triples` only when caller already has structured node IDs.

## Orchestrator

Location: `apps/orchestrator`.

Conceptual flow:

```text
MetaAgent
  decomposes document into research branches
Specialist agents
  Finance, Legal, People/Org, Strategy/Market, Technical/Ops
Workers
  extract triples from chunks
Supervisor
  filters/reviews triples
Normalizer
  deduplicates entities and relationships
Emitter
  posts agent events and triples back to apps/api
```

Important files:

```text
src/index.ts                 main orchestration entrypoint
src/agents/meta.ts           document decomposition
src/agents/specialists.ts    specialist profiles
src/agents/worker.ts         chunk-level triple extraction
src/agents/supervisor.ts     optional review
src/agents/expander.ts       node follow-up expansion
src/agents/json.ts           robust JSON parsing/salvage
src/ingest/chunker.ts        chunking/sampling
src/ingest/normalizer.ts     entity ID normalization/dedupe/connectivity helpers
src/tools/emit.ts            API callback posting
```

Keep LLM usage conservative. Anthropic rate limits were a real problem. Existing controls include:

```env
MAX_ANTHROPIC_CONCURRENCY=1
ORCHESTRATOR_MAX_INPUT_CHARS=120000
ORCHESTRATOR_MAX_CHUNKS=12
SUPERVISOR_REVIEW_ENABLED=false
```

For large docs, sample or cap chunks rather than running every specialist over everything.

## Frontend Graph Behavior

Location: `frontend/src/components/knowledge-graph`.

Most important file:

```text
KnowledgeGraphCanvas.tsx
```

Responsibilities:

```text
create run
open SSE stream
upsert nodes/edges from events
handle document uploads
trigger swarm extraction
render Sigma graph
handle active-node neighborhood view
handle node click / node query / expansion
```

The graph intentionally does not render every node at once for large documents. The expected UX is:

1. Start from the main/high-degree node.
2. Show only that active node plus level-1 neighbors.
3. Neighbor nodes show a child/hidden count badge.
4. Clicking a neighbor makes it the new center.
5. Its children then appear around it.

When modifying layout, avoid global spreading. The desired layout is compact:

```text
active/highest-degree node at center
visible neighbors clustered close around it
more children shown only after clicking into that node
```

Large full-graph renders caused freezes. Prefer progressive/neighborhood rendering.

## MCP Notes

MCP means Model Context Protocol. It lets AI tools access external data sources through a common protocol.

For this app, the practical demo path is local filesystem MCP:

```text
filesystem MCP stdio server
  -> apps/mcp-bridge HTTP wrapper on :8790
  -> apps/api MCP proxy endpoints
  -> orchestrator/frontend
```

The user-facing connector was designed as a downloadable zip with scripts and README. Drag/drop upload is the more reliable path for demos.

## Supabase Setup

Use:

```text
supabase/migrations/0001_initial_schema.sql
```

For a quick hosted Supabase setup, paste/run the migration SQL in Supabase SQL editor, then put these in `.env`:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

If Supabase is not configured, the API may still work in memory for demo/SSE, but persistence and reloads will be incomplete.

## Environment Variables

Backend/API:

```env
PORT=8787
CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:5174
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
MCP_SERVER_URL=http://localhost:8790
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
SWARM_ORCHESTRATOR_CWD=
SWARM_TIMEOUT_MS=120000
ORCHESTRATOR_STUB_MODE=false
```

Frontend:

```env
VITE_API_BASE_URL=http://localhost:8787
```

Do not hardcode API keys. If a key appears in chat/history, avoid committing it.

## Common Problems And Fixes

### CORS preflight fails

Check `CORS_ORIGINS` includes the frontend origin. Browser errors often mention missing `Access-Control-Allow-Origin`.

### Graph says completed but 0 triples

Usually orchestrator extraction failed and fallback did not persist, or malformed JSON could not be salvaged. Check `apps/api` logs and orchestrator logs.

### Anthropic 429 rate limits

Reduce concurrency and output:

```env
MAX_ANTHROPIC_CONCURRENCY=1
ORCHESTRATOR_MAX_CHUNKS=6
SUPERVISOR_REVIEW_ENABLED=false
```

Keep prompts compact and avoid running many branches over many chunks.

### Large graph freezes

Do not render all nodes. Keep Sigma whole-graph rendering responsive with edge caps, semantic buckets, and level-of-detail labels. If adding features, prefer:

```text
top N visible nodes
active node + 1-hop neighbors
expand on click
no global fitView loops on every SSE event
layout off main thread where possible
```

### Page blanks when graph updates

Usually caused by replacing too much graph state at once or forcing expensive layout on every burst. Keep upserts incremental and avoid camera resets during ordinary SSE updates.

### Bad JSON from model

Use the existing JSON salvage helpers in `apps/orchestrator/src/agents/json.ts`. Do not assume perfect model JSON.

### MCP path rejected

Use absolute paths, not `~`.

## Coding Guidance

Keep abstractions minimal. This was built under hackathon constraints and should stay direct.

Do:

```text
reuse existing API endpoints
preserve SSE event contracts
preserve raw-triples ingestion
keep LLM calls rate-limit aware
keep frontend graph progressive
build before finishing
```

Avoid:

```text
large rewrites
new graph frameworks unless absolutely necessary
rendering all nodes for large docs
turning web search into primary ingestion
committing keys
dropping source references from edges
```

## Presentation Summary

Dev 1 / infrastructure role:

```text
I built the data and realtime infrastructure. Files or MCP sources enter the backend, the orchestrator turns them into structured triples, Supabase stores the graph state, and SSE streams each node, edge, source, and reasoning step to the UI as it happens.
```

SSE explanation:

```text
Server-Sent Events keep a one-way HTTP stream open from backend to browser. Instead of the UI polling, the backend pushes graph updates immediately. It is simpler than WebSockets for our use case because all realtime updates flow from server to client.
```

MCP explanation:

```text
MCP is a standard protocol that lets AI agents access external tools and private data sources, such as local files, Git repositories, or databases. We wrap local MCP servers with an HTTP bridge so the backend can use them.
```
