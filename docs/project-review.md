# Agentic Research Swarm & Live Knowledge Graph Review

## Project Goal

Build a hackathon-grade enterprise research tool that accepts a complex research prompt, launches multiple specialized AI agents, gathers internal and external evidence, extracts structured Subject-Predicate-Object triples, and streams the evolving results into a live React Flow knowledge graph.

The winning demo should show that the system can:

- Start a research run from the frontend.
- Fan out work to specialist agents.
- Use web search and internal data access tools.
- Persist graph nodes, graph edges, agent reasoning steps, and sources.
- Update the frontend in real time as agents work.
- Explain where graph facts came from.

## Architecture Summary

The system has four main layers:

1. Frontend
   - Lovable-generated React/TypeScript app.
   - React Flow/XyFlow for the live graph.
   - Subscribes to Supabase Realtime and/or backend SSE events.

2. Backend API
   - Custom long-running server, preferably Express + TypeScript for speed.
   - Owns CORS, SSE, run lifecycle endpoints, and integration wrappers.
   - Provides a stable surface for the frontend and AI orchestrator.

3. Data Layer
   - Supabase Auth, Postgres, and Realtime.
   - Stores research runs, graph nodes, graph edges, agent events, and sources.
   - Uses `run_id` as the common join key.

4. AI and Tools
   - Triage agent breaks the user prompt into specialist tasks.
   - Specialist agents use web search and internal data tools.
   - Agents output strict JSON structures containing SPO triples and sources.
   - Backend persists structured results and broadcasts progress.

## Developer 1 Scope: Data & Infrastructure

Developer 1 owns the pipes. The priority is not perfect architecture; it is making every boundary between frontend, database, backend, search, and internal data work reliably during the demo.

Primary responsibilities:

- Backend server scaffold.
- CORS configuration for Lovable, localhost, and deployed origins.
- Server-Sent Events endpoint for live streaming.
- Supabase schema and Realtime setup.
- Search API wrapper for Tavily or Brave.
- MCP/SSE bridge or adapter for internal data access.
- Integration contracts for Developer 2 and Developer 3.

## Highest-Risk Areas

1. CORS and streaming from Lovable
   - Lovable preview domains can be strict and change during iteration.
   - SSE requires correct headers and no response buffering.
   - Add heartbeat messages to avoid idle disconnects.

2. Long-running agent loops
   - Supabase Edge Functions may time out.
   - A custom Express/FastAPI server is safer for hackathon agent runs.

3. Data contract drift
   - AI output, database schema, and React Flow node/edge expectations must align.
   - Define stable payload shapes early and keep them small.

4. Realtime reliability
   - Supabase Realtime is useful, but SSE should remain a fallback path.
   - The frontend should be able to render from either persisted records or streamed deltas.

5. Structured AI output quality
   - Developer 2 must emit strict JSON.
   - Database inserts should validate enough to reject malformed nodes/edges.

## Recommended Minimal Backend API

Implement these first:

- `GET /health`
  - Returns service status and configured integrations.

- `POST /runs`
  - Creates a research run.
  - Accepts `{ "prompt": string }`.
  - Returns `{ "runId": string }`.

- `GET /runs/:runId/events`
  - Opens an SSE stream.
  - Emits `run.status`, `agent.step`, `node.created`, `edge.created`, `source.created`, and `error` events.

- `POST /runs/:runId/agent-events`
  - Lets the orchestrator write reasoning/progress events.

- `POST /runs/:runId/triples`
  - Accepts extracted SPO triples and persists graph nodes/edges/sources.

- `POST /search`
  - Temporary test endpoint for the search wrapper.
  - Can be removed or protected later.

## Recommended Supabase Tables

Use simple schemas with JSONB metadata to avoid blocking the team on migrations.

- `research_runs`
  - `id`
  - `prompt`
  - `status`
  - `created_at`
  - `updated_at`
  - `metadata`

- `graph_nodes`
  - `id`
  - `run_id`
  - `label`
  - `type`
  - `properties`
  - `created_by_agent`
  - `created_at`

- `graph_edges`
  - `id`
  - `run_id`
  - `source_node_id`
  - `target_node_id`
  - `predicate`
  - `confidence`
  - `properties`
  - `created_by_agent`
  - `created_at`

- `agent_events`
  - `id`
  - `run_id`
  - `agent_name`
  - `event_type`
  - `message`
  - `payload`
  - `created_at`

- `sources`
  - `id`
  - `run_id`
  - `url`
  - `title`
  - `snippet`
  - `source_type`
  - `metadata`
  - `created_at`

## Event Contract

All live events should include:

- `type`
- `runId`
- `timestamp`
- `payload`

Event types:

- `run.created`
- `run.started`
- `run.completed`
- `run.failed`
- `agent.step`
- `node.created`
- `edge.created`
- `source.created`
- `error`

## 24-Hour Execution Plan

1. First 2 hours
   - Create backend scaffold.
   - Add health endpoint.
   - Add CORS config.
   - Add `.env.example`.

2. Hours 2-5
   - Add Supabase migrations.
   - Add Supabase client.
   - Add basic insert helpers for runs, nodes, edges, sources, and events.

3. Hours 5-8
   - Implement SSE stream manager.
   - Add heartbeat.
   - Add demo event endpoint or seed route.
   - Test from browser.

4. Hours 8-11
   - Add Tavily or Brave search wrapper.
   - Normalize search results.
   - Add graceful errors when API key is missing.

5. Hours 11-15
   - Add MCP adapter skeleton.
   - Keep it narrow: one interface for internal search/read operations.

6. Hours 15-19
   - Freeze integration contracts with Developer 2 and Developer 3.
   - Add sample payloads in docs.

7. Hours 19-24
   - Stabilize CORS, streaming, and Supabase Realtime.
   - Add logging.
   - Prepare demo seed data and fallback paths.

## Practical Decision

Use Express + TypeScript unless the team has already committed to Python. Express makes browser CORS and SSE work very quickly, and Developer 3 can consume the API without needing Python-specific deployment assumptions.

