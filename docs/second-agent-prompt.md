# Prompt For Second Coding Agent

You are working in the `KnowledgeSwarm` repository on the `infra-foundation` branch.

## Project Context

We are a 3-person team building a 24-hour hackathon prototype: an enterprise research tool that orchestrates a swarm of specialized AI agents and visualizes their findings in real time as a dynamic knowledge graph.

The user is Developer 1, responsible for data and infrastructure. Your job is to help implement the backend/data foundation quickly and pragmatically.

Core stack:

- Frontend: Lovable React/TypeScript.
- Graph UI: React Flow/XyFlow.
- Backend: Express + TypeScript preferred unless an existing scaffold says otherwise.
- Database: Supabase Postgres with Realtime.
- Streaming: Server-Sent Events from backend to browser.
- AI orchestration: OpenAI Agents SDK/OpenAI Swarm-style handoffs and/or Claude, implemented by another teammate.
- Structured extraction: AI agents output Subject-Predicate-Object triples.
- Search: Tavily or Brave Search.
- Internal data access: MCP servers, ideally bridged through backend adapters.

The repo may be mostly empty. Prefer minimal abstractions and fast, working contracts over enterprise architecture.

## Your Role

Implement infrastructure pieces that unblock the frontend developer and AI/orchestration developer.

Do not build the full AI swarm unless explicitly asked. Focus on:

- Backend server.
- CORS.
- SSE.
- Supabase schema.
- Supabase insert helpers.
- Search API wrapper.
- MCP adapter skeleton.
- Clear integration contracts and examples.

## Required Implementation

Create a lean Express + TypeScript backend under `apps/api`.

Recommended files:

- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/src/index.ts`
- `apps/api/src/config.ts`
- `apps/api/src/sse.ts`
- `apps/api/src/supabase.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/search.ts`
- `apps/api/src/services/graph.ts`
- `apps/api/src/services/search.ts`
- `apps/api/src/services/mcp.ts`
- `.env.example`
- `supabase/migrations/0001_initial_schema.sql`
- `docs/api-contract.md`

## Backend Endpoints

Implement:

### `GET /health`

Returns:

```json
{
  "ok": true,
  "service": "knowledge-swarm-api",
  "integrations": {
    "supabase": true,
    "search": false
  }
}
```

### `POST /runs`

Accepts:

```json
{
  "prompt": "Research..."
}
```

Creates a `research_runs` row if Supabase is configured. If Supabase is not configured, return an in-memory run ID so local frontend testing still works.

Returns:

```json
{
  "runId": "uuid"
}
```

### `GET /runs/:runId/events`

Server-Sent Events stream.

Requirements:

- Set correct SSE headers.
- Allow CORS.
- Send heartbeat every 15 seconds.
- Support these event names:
  - `run.status`
  - `agent.step`
  - `node.created`
  - `edge.created`
  - `source.created`
  - `error`

### `POST /runs/:runId/agent-events`

Accepts:

```json
{
  "agentName": "FinanceAgent",
  "eventType": "reasoning",
  "message": "Checking SEC filings",
  "payload": {}
}
```

Persists to Supabase if configured and broadcasts an SSE `agent.step` event.

### `POST /runs/:runId/triples`

Accepts:

```json
{
  "agentName": "FinanceAgent",
  "triples": [
    {
      "subject": {
        "id": "company:acme",
        "label": "Acme Corp",
        "type": "Company",
        "properties": {}
      },
      "predicate": "acquired",
      "object": {
        "id": "company:beta",
        "label": "Beta Inc",
        "type": "Company",
        "properties": {}
      },
      "confidence": 0.84,
      "sources": [
        {
          "url": "https://example.com",
          "title": "Acme buys Beta",
          "snippet": "..."
        }
      ],
      "properties": {}
    }
  ]
}
```

Persists graph nodes, graph edges, and sources if Supabase is configured. Broadcasts `node.created`, `edge.created`, and `source.created` SSE events.

### `POST /search`

Accepts:

```json
{
  "query": "latest battery acquisition news"
}
```

Uses Tavily or Brave depending on available env vars. If no key is configured, return a clear `503` with a helpful message.

Normalize results to:

```json
{
  "results": [
    {
      "title": "string",
      "url": "string",
      "snippet": "string",
      "content": "string optional",
      "score": 0.5
    }
  ]
}
```

## Supabase Migration

Create these tables:

- `research_runs`
- `graph_nodes`
- `graph_edges`
- `agent_events`
- `sources`

Use UUID primary keys where useful, `run_id` foreign keys, `jsonb` metadata/properties columns, and `created_at` timestamps.

Enable Realtime publication for graph and event tables if possible in SQL:

- `graph_nodes`
- `graph_edges`
- `agent_events`
- `sources`

Keep RLS disabled or very simple for the hackathon unless the user asks for production auth.

## Environment Variables

Add `.env.example` with:

```bash
PORT=8787
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
MCP_SERVER_URL=
```

## Engineering Constraints

- Keep implementation simple.
- Do not introduce heavy frameworks.
- Do not over-abstract.
- Prefer explicit functions and small modules.
- The backend must run locally with `npm install` and `npm run dev`.
- If Supabase credentials are missing, the backend should still start and support basic local demo behavior.
- Use `zod` for request validation if it does not slow you down.
- Add enough logging to debug CORS/SSE/API problems quickly.

## Deliverables

When finished, report:

- Files changed.
- How to run the backend.
- Example curl commands for `/health`, `/runs`, `/runs/:runId/events`, `/runs/:runId/triples`, and `/search`.
- Any environment variables needed.
- Any known gaps or assumptions.

## Important Collaboration Note

Another agent or human may be editing this repo at the same time. Do not revert unrelated changes. Keep your edits scoped to backend infrastructure, Supabase schema, and docs.

