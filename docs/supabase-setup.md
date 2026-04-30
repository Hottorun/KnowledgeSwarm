# Supabase Setup

## What You Need

From your Supabase project dashboard:

- Project URL: `SUPABASE_URL`
- Service role key: `SUPABASE_SERVICE_ROLE_KEY`

Use the service role key only on the backend. Do not put it in Lovable/frontend code.

## Fastest Hackathon Setup

1. Open Supabase Dashboard.
2. Go to SQL Editor.
3. Open [supabase/migrations/0001_initial_schema.sql](../supabase/migrations/0001_initial_schema.sql).
4. Copy the full SQL contents.
5. Paste into SQL Editor.
6. Run it once.

The migration is written to be mostly idempotent, so rerunning should not recreate existing tables. If Supabase complains about Realtime publication membership, tell Codex the exact error.

## Backend Env

Create `apps/api/.env` or repo-root `.env`:

```bash
PORT=8787
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
BRAVE_SEARCH_API_KEY=your-brave-key
SEARCH_MAX_RESULTS=5
MCP_SERVER_URL=
```

`dotenv` loads from the current working directory. If you start the API from `apps/api`, put `.env` in `apps/api/.env`.

## Realtime Check

In Supabase Dashboard:

1. Go to Database.
2. Go to Replication or Realtime settings.
3. Confirm these tables are enabled:
   - `research_runs`
   - `graph_nodes`
   - `graph_edges`
   - `sources`
   - `agent_events`

The frontend can use backend SSE first. Supabase Realtime is useful, but not required for the first working graph demo.

## Smoke Test

```bash
cd apps/api
npm install
npm run dev
```

Then:

```bash
curl http://localhost:8787/health
```

Expected:

```json
{
  "ok": true,
  "service": "knowledge-swarm-api",
  "integrations": {
    "supabase": true,
    "search": true,
    "mcp": false
  }
}
```

