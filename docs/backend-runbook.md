# Backend Runbook

Express + TypeScript API for Knowledge Swarm. Routes under `apps/api`.

## Local Setup

```bash
cd apps/api
cp ../../.env.example .env
npm install
npm run dev
```

Server starts on `http://localhost:8787`.

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | Server port (default: 8787) |
| `CORS_ORIGINS` | No | Comma-separated origins (default: localhost:3000,5173) |
| `SUPABASE_URL` | Yes for persistence | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes for persistence | Service role key |
| `TAVILY_API_KEY` | Yes for search | Tavily API key |
| `BRAVE_SEARCH_API_KEY` | Yes for search (alt) | Brave Search API key |
| `MCP_SERVER_URL` | No | MCP server endpoint |
| `SEARCH_MAX_RESULTS` | No | Max search results (default: 5) |

The server starts without Supabase or search keys. Runs use in-memory UUIDs and triples broadcast via SSE only.

## Supabase Migration

1. Create a Supabase project.
2. Run `supabase/migrations/0001_initial_schema.sql` in the SQL Editor.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
4. Verify with `GET /health` — `integrations.supabase` should be `true`.

The migration creates: `research_runs`, `graph_nodes`, `graph_edges`, `sources`, `edge_sources`, `agent_events` with realtime publication and `replica identity full`.

## Curl Smoke Tests

```bash
# Health
curl http://localhost:8787/health

# Create a run
RUN_ID=$(curl -s -X POST http://localhost:8787/runs \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Test run"}' | jq -r .runId)
echo "Run ID: $RUN_ID"

# SSE stream (run in another terminal)
curl -N http://localhost:8787/runs/$RUN_ID/events

# Agent event
curl -X POST http://localhost:8787/runs/$RUN_ID/agent-events \
  -H "Content-Type: application/json" \
  -d '{"agentName": "TestAgent", "eventType": "reasoning", "message": "Starting analysis"}'

# Triples
curl -X POST http://localhost:8787/runs/$RUN_ID/triples \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "TestAgent",
    "triples": [{
      "subject": {"id": "company:acme", "label": "Acme Corp", "type": "Company"},
      "predicate": "acquired",
      "object": {"id": "company:beta", "label": "Beta Inc", "type": "Company"},
      "confidence": 0.84,
      "sources": [{"url": "https://example.com", "title": "Acme buys Beta"}]
    }]
  }'

# Search
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "battery technology"}'

# Demo seed (generates sample data without AI orchestrator)
curl -X POST http://localhost:8787/demo/seed \
  -H "Content-Type: application/json" \
  -d '{"runId": "'$RUN_ID'"}'
```

## CORS Troubleshooting

- **Preflight failures**: Check that your frontend origin matches `CORS_ORIGINS`. Default includes `http://localhost:3000` and `http://localhost:5173`.
- **Credentials**: CORS is configured with `credentials: true`. If the frontend sends `withCredentials`, the origin must be explicit (no `*`).
- **Logs**: Every request is logged as `METHOD /path`. Check server output for incoming preflight `OPTIONS` requests.

## SSE Troubleshooting

- **No events received**: Confirm `Content-Type: text/event-stream` in response headers. Some proxies (nginx, Vercel) buffer SSE — set `X-Accel-Buffering: no`.
- **Connection drops**: The server sends `: heartbeat` comments every 15 seconds. If your client sees no data for >30s, the connection is likely dead.
- **Run-scoped events**: SSE clients subscribe to a specific `runId`. Only events for that run are forwarded. Events for other runs are silently ignored.
- **Multiple clients**: Supported. Each connection is independent. Dead clients are cleaned up automatically.

## Known Gaps

- No production auth or RLS. This is a hackathon prototype.
- SSE clients are in-memory only. A restart drops all connections.
- No retry logic for Supabase insert failures. Errors are logged and returned as 500.
