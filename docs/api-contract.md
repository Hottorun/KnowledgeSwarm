# API Contract

This contract is shared by the Lovable frontend, the AI orchestrator, and the infrastructure backend.

Base URL for local development:

```text
http://localhost:8787
```

## Event Envelope

Every streamed event uses this shape:

```json
{
  "type": "agent.step",
  "runId": "4d9f5b9e-4f52-45fb-8e20-81b7f271eccc",
  "timestamp": "2026-04-30T12:00:00.000Z",
  "payload": {}
}
```

Supported event types:

- `run.created`
- `run.started`
- `run.completed`
- `run.failed`
- `agent.step`
- `node.created`
- `edge.created`
- `source.created`
- `error`

## `GET /health`

Returns backend status and integration availability.

Response:

```json
{
  "ok": true,
  "service": "knowledge-swarm-api",
  "integrations": {
    "supabase": true,
    "search": false,
    "mcp": false
  }
}
```

## `POST /runs`

Creates a research run.

Request:

```json
{
  "prompt": "Research the competitive risks for Acme entering the battery market."
}
```

Response:

```json
{
  "runId": "4d9f5b9e-4f52-45fb-8e20-81b7f271eccc"
}
```

Side effects:

- Inserts `research_runs` when Supabase is configured.
- Broadcasts `run.created`.

## `GET /runs/:runId/events`

Opens a Server-Sent Events stream for live graph and agent updates.

Required response headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Example event:

```text
event: agent.step
data: {"type":"agent.step","runId":"4d9f5b9e-4f52-45fb-8e20-81b7f271eccc","timestamp":"2026-04-30T12:00:00.000Z","payload":{"agentName":"FinanceAgent","eventType":"reasoning","message":"Checking acquisition filings","payload":{}}}
```

The server should send a heartbeat comment every 15 seconds:

```text
: heartbeat
```

## `POST /runs/:runId/agent-events`

Records and streams an agent progress or reasoning event.

Request:

```json
{
  "agentName": "FinanceAgent",
  "eventType": "reasoning",
  "message": "Checking acquisition filings",
  "payload": {
    "query": "Acme battery acquisitions"
  }
}
```

Response:

```json
{
  "ok": true
}
```

Side effects:

- Inserts `agent_events`.
- Broadcasts `agent.step`.

## `POST /runs/:runId/triples`

Persists SPO triples as graph nodes, graph edges, and sources.

Request:

```json
{
  "agentName": "FinanceAgent",
  "triples": [
    {
      "subject": {
        "id": "company:acme",
        "label": "Acme Corp",
        "type": "Company",
        "properties": {
          "ticker": "ACME"
        }
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
          "url": "https://example.com/acme-beta",
          "title": "Acme buys Beta",
          "snippet": "Acme announced the acquisition of Beta."
        }
      ],
      "properties": {
        "date": "2026-04-01"
      }
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "persisted": 1
}
```

Side effects:
- Broadcasts `node.created`, `edge.created`, and `source.created`.

## `POST /search`

Runs web search through Tavily or Brave.

Request:

```json
{
  "query": "latest battery acquisition news"
}
```

Response:

```json
{
  "results": [
    {
      "title": "Acme buys Beta",
      "url": "https://example.com/acme-beta",
      "snippet": "Acme announced the acquisition of Beta.",
      "content": "Optional expanded content",
      "score": 0.91
    }
  ]
}
```

If no search API key is configured, return:

```json
{
  "error": "Search is not configured. Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY."
}
```

with HTTP status `503`.

## React Flow Mapping

Frontend should map:

- `graph_nodes.id` to React Flow `node.id`.
- `graph_nodes.label` to visible node label.
- `graph_nodes.type` to visual node category.
- `graph_edges.id` to React Flow `edge.id`.
- `graph_edges.source_node_id` to `edge.source`.
- `graph_edges.target_node_id` to `edge.target`.
- `graph_edges.predicate` to edge label.

## Orchestrator Contract

Developer 2 should only need these operations:

1. Create a run with `POST /runs`.
2. Stream progress with `POST /runs/:runId/agent-events`.
3. Persist extracted triples with `POST /runs/:runId/triples`.
4. Use `POST /search` as a web search tool.

The orchestrator should emit stable node IDs. Recommended formats:

- `company:acme`
- `person:jane-doe`
- `document:annual-report-2025`
- `market:lithium-batteries`

