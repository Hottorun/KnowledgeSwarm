# Developer Handoff: Ingestion-First Pivot

The project now starts with user data ingestion, not web research.

## Tell Developer 2

Your orchestration flow should change to:

1. Accept files or MCP content selected by the user.
2. Extract plain text/rows from each source.
3. Call `POST /runs/:runId/chunks` for long text if useful.
4. Run LLM extraction on chunks and output raw SPO triples.
5. Call `POST /runs/:runId/raw-triples`.
6. When the user clicks a node and asks a question:
   - answer from graph/files first
   - if insufficient, call `/search`
   - append new facts to the same graph

Useful endpoint for simple extraction output:

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
      }
    }
  ]
}
```

## Tell Developer 3

Your frontend flow should change to:

1. First screen offers:
   - MCP connection instructions/status
   - drag/drop file upload
   - start ingestion button
2. On start, call `POST /runs`, open SSE, and show graph as events arrive.
3. Clicking a node opens a side panel:
   - node label/type/properties
   - connected edges
   - source snippets
   - question input
   - "research more" action
4. New research should expand the same graph, not create a separate result page.

## What Stays The Same

- Supabase tables still work.
- SSE event envelope still works.
- React Flow mapping still works.
- Search API still works, but now mainly for node expansion.

## What Not To Duplicate

- Developer 2 should own file parsing and AI extraction.
- Backend owns normalization/persistence/streaming.
- Frontend owns upload UX, graph rendering, and node interaction.

