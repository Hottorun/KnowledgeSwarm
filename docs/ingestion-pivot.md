# Ingestion-First Product Pivot

The product flow changed from "start with web research" to "start by building a graph from user-provided knowledge, then research selected nodes."

## New Primary Flow

1. User connects a data source or uploads files.
   - MCP server: filesystem, Postgres, Git repo, internal docs, etc.
   - Manual upload: PDF, Excel/CSV, text, markdown, docs.
2. Backend/orchestrator extracts readable text or rows.
3. Text is chunked with overlap.
4. AI extraction turns chunks into SPO triples.
5. Backend normalizes entities and predicates.
6. Backend persists graph nodes/edges/sources and streams deltas to the frontend.
7. Frontend renders a mindmap/knowledge graph.
8. User clicks a node and asks a question.
9. AI answers from graph/files first, then uses web search if needed.
10. New findings expand the same graph.

## What Changed

The graph is no longer only a visualization of external research. It is the core knowledge base created from user data first.

Existing infrastructure still applies:

- `research_runs` can represent an ingestion workspace/session.
- `graph_nodes`, `graph_edges`, and `sources` still fit the graph model.
- SSE still streams graph changes.
- Search still supports node-level online expansion.

New emphasis:

- File/MCP ingestion before web search.
- Entity standardization across many files.
- Source references to uploaded files, pages, sheets, rows, or MCP paths.
- Node-click question answering.

## Reference Repo Takeaways

From `robert-mcdermott/ai-knowledge-graph`:

- Use overlapping word chunks before extraction.
- Extract SPO triples per chunk.
- Standardize entity names across chunks.
- Limit predicates to short relationship labels.
- Infer relationships later, after the explicit graph exists.

This repo is Apache-2.0 licensed.

From `samitugal/KnowledgeGraphQA-Langgraph`:

- Use a router-style workflow:
  - generate graph
  - answer from graph
  - fall back to web search
  - generate final answer
- The cloned repo did not include a visible license file, so treat it as architectural inspiration only unless the license is confirmed.

## Backend Additions

Two helper endpoints support the new flow:

### `POST /runs/:runId/chunks`

Takes raw extracted text and returns overlapping chunks.

```json
{
  "text": "Long document text...",
  "chunkSize": 500,
  "overlap": 50
}
```

### `POST /runs/:runId/raw-triples`

Accepts simple extracted triples from an LLM/parser and normalizes them into graph nodes/edges.

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
        "snippet": "Acme Corp acquired Beta Inc..."
      }
    }
  ]
}
```

## Developer Coordination

Tell Developer 2:

- Their first job is now document/MCP extraction into raw triples, not only web research.
- They can call `/runs/:runId/chunks` before LLM extraction.
- They can call `/runs/:runId/raw-triples` with simple string triples.
- For node questions, answer from the graph/files first, and only then call `/search`.

Tell Developer 3:

- The first screen should support MCP connection instructions and drag/drop upload.
- The graph should render after ingestion, before any web research happens.
- Clicking a node should open a side panel with node details, source snippets, and a question box.
- Node-level research should append to the existing graph, not create a separate graph.

