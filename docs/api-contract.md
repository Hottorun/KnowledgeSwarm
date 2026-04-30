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

## `POST /runs/:runId/chunks`

Splits extracted document text into overlapping chunks for LLM extraction.

Request:

```json
{
  "text": "Long document text...",
  "chunkSize": 500,
  "overlap": 50
}
```

Response:

```json
{
  "ok": true,
  "chunks": [
    {
      "index": 0,
      "text": "Chunk text...",
      "startWord": 0,
      "endWord": 500
    }
  ]
}
```

## `POST /runs/:runId/uploads/text`

Receives text already read by the browser from drag/drop files and returns chunks for AI extraction.

Frontend should use this for `.txt`, `.md`, and `.csv` first. PDF/Excel can be parsed later by frontend libraries or the orchestrator.

Request:

```json
{
  "files": [
    {
      "name": "notes.md",
      "mimeType": "text/markdown",
      "content": "Acme Corp acquired Beta Inc..."
    }
  ],
  "chunkSize": 500,
  "overlap": 50
}
```

Response:

```json
{
  "ok": true,
  "files": 1,
  "chunks": 1,
  "documents": [
    {
      "name": "notes.md",
      "mimeType": "text/markdown",
      "chunks": [
        {
          "index": 0,
          "text": "Acme Corp acquired Beta Inc...",
          "startWord": 0,
          "endWord": 5
        }
      ]
    }
  ]
}
```

## `POST /runs/:runId/raw-triples`

Accepts simple string-based triples from file/MCP extraction and normalizes them into graph nodes and edges.

Request:

```json
{
  "agentName": "IngestionAgent",
  "triples": [
    {
      "subject": "Acme Corp",
      "predicate": "acquired",
      "object": "Beta Inc",
      "subjectType": "Company",
      "objectType": "Company",
      "confidence": 0.84,
      "source": {
        "documentName": "acquisitions.pdf",
        "page": 3,
        "snippet": "Acme Corp acquired Beta Inc."
      },
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
  "received": 1,
  "persisted": 1
}
```

Use this endpoint when the AI/extraction layer has raw SPO strings and does not want to construct frontend-ready node IDs.

## `GET /downloads/knowledge-swarm-connector.zip`

Downloads the local files connector bundle.

The ZIP contains:

- `connector.js`
- `start-mac-linux.sh`
- `start-windows.ps1`
- `README.txt`

The connector runs locally at `http://localhost:8790` and exposes:

- `GET /health`
- `GET /tools/list`
- `POST /tools/call`

It only reads the folder the user passes to the startup script.

## MCP Connector Proxy

These endpoints let the frontend/backend verify and read from a local MCP connector through the API.

### `GET /mcp/health`

Checks whether `MCP_SERVER_URL` is configured and reachable.

### `GET /mcp/tools`

Lists available bridge tools.

### `GET /mcp/allowed-directories`

Returns the connector's allowed directories.

### `POST /mcp/list-directory`

Request:

```json
{
  "path": "/absolute/allowed/folder"
}
```

### `POST /mcp/read-file`

Request:

```json
{
  "path": "/absolute/allowed/folder/file.txt"
}
```

### `POST /mcp/search-files`

Request:

```json
{
  "path": "/absolute/allowed/folder",
  "pattern": "*.txt"
}
```

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
