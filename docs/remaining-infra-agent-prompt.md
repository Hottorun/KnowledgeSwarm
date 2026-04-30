# Prompt For Other Coding Agent: Remaining Infrastructure Tasks

You are working in the `KnowledgeSwarm` repository after the backend foundation has been merged. The current API already builds and exposes Express routes for runs, SSE, triples, search, and MCP skeletons.

Your task is to finish the remaining infrastructure hardening without changing the public API contract unless absolutely necessary.

## Context

This is a 24-hour hackathon project. Keep changes small and practical.

Developer 1 owns:

- Supabase setup and Realtime.
- CORS and SSE reliability.
- Search API integration.
- MCP/local data bridge.
- Backend environment readiness.

Developer 2 has the API contract and will post agent events/triples.
Developer 3 has the frontend integration guide and will consume SSE events.

## Tasks

1. Add a `README.md` section or `docs/backend-runbook.md` with:
   - Local setup.
   - Required env vars.
   - Supabase migration instructions.
   - Curl smoke tests.
   - Common CORS/SSE troubleshooting.

2. Add an optional demo seed endpoint or script:
   - Should create a run or accept a run ID.
   - Should emit 2-3 nodes, 1-2 edges, one source, and one agent event.
   - This helps Developer 3 test the graph without waiting for the AI orchestrator.
   - Keep it clearly marked as demo/dev only.

3. Verify Supabase persistence once credentials are available:
   - `POST /runs` inserts into `research_runs`.
   - `POST /runs/:runId/agent-events` inserts into `agent_events`.
   - `POST /runs/:runId/triples` inserts/upserts `graph_nodes`, inserts `graph_edges`, inserts `sources`, and links `edge_sources`.
   - Supabase Realtime is enabled for graph/event tables.

4. Verify Brave Search only once after `BRAVE_SEARCH_API_KEY` is configured:
   - Use a single broad query.
   - Confirm response normalization.
   - Do not repeatedly call Brave. The project has limited quota.

5. Improve error reporting if needed:
   - Supabase insert failures should be visible in logs and HTTP responses.
   - Search errors should include provider and status code.
   - Do not leak secret env values.

## Constraints

- Do not commit `.env`.
- Do not print API keys.
- Do not remove existing endpoints.
- Do not make heavy abstractions.
- Keep TypeScript build passing with `npm run build` in `apps/api`.

## Deliverables

Report:

- Files changed.
- Exact verification commands run.
- Whether Supabase was verified with real credentials.
- Whether Brave was verified, and how many requests were used.
- Any remaining blockers for Developer 2 or Developer 3.

