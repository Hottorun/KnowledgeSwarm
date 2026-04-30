# Remaining Task List

Current product direction: users first connect local data through MCP or drag/drop files, the system builds a knowledge graph/mindmap from that data, and then users click nodes to ask follow-up questions or trigger online research.

## Current State

Implemented:

- Express API in `apps/api`.
- Supabase schema for runs, nodes, edges, sources, and agent events.
- SSE event stream for live graph updates.
- Search wrapper for Brave/Tavily.
- Raw triple normalization endpoint:
  - `POST /runs/:runId/raw-triples`
- Text chunking endpoint:
  - `POST /runs/:runId/chunks`
- Demo seed endpoint.
- Local MCP HTTP bridge scaffold in `apps/mcp-bridge`.
- Filesystem MCP launch helper in `scripts/start-filesystem-mcp.sh`.

Still missing:

- Frontend upload/MCP UX.
- Actual file parsing for PDF/Excel/documents.
- AI extraction from chunks to SPO triples.
- Node-click question answering.
- A polished downloadable/local connector story.
- End-to-end demo script.

## Priority 0: Stabilize Existing Work

Owner: Developer 1

- Run builds:
  - `cd apps/api && npm run build`
  - `cd apps/mcp-bridge && npm install && npm run build`
- Verify API on `localhost:8787`.
- Verify bridge on `localhost:8790` with a small demo folder.
- Confirm `MCP_SERVER_URL=http://localhost:8790` in `apps/api/.env`.
- Remove generated/local junk from commits:
  - `.DS_Store`
  - `dist/`
  - `node_modules/`
  - `.env`

## Priority 1: Reliable Drag/Drop Ingestion

Owner: Developer 2 + Developer 3

This is the guaranteed demo path.

Tasks:

- Frontend drag/drop file UI.
- File type support:
  - `.txt`
  - `.md`
  - `.csv`
  - `.xlsx`
  - `.pdf`
- Extract text/rows from files.
- Send extracted text to orchestration.
- Chunk long text with `/runs/:runId/chunks`.
- AI extracts raw SPO triples.
- Post raw triples to `/runs/:runId/raw-triples`.
- Render graph updates from SSE.

Recommended hackathon shortcut:

- Parse `.txt`, `.md`, and `.csv` first.
- Add PDF/Excel only if time allows.
- For PDF/Excel, use established libraries rather than custom parsing.

## Priority 2: MCP Filesystem Demo

Owner: Developer 1

The bridge now exists in `apps/mcp-bridge`. Finish and verify it.

Tasks:

- Install bridge deps.
- Build bridge.
- Start bridge with one allowed demo folder.
- Call:
  - `GET /health`
  - `GET /tools/list`
  - `POST /tools/call` with `list_allowed_directories`
  - `POST /tools/call` with `list_directory`
  - `POST /tools/call` with `read_file`
- Point API to bridge:
  - `MCP_SERVER_URL=http://localhost:8790`
- Add one API endpoint or orchestrator function that reads selected MCP files and sends their contents into the same ingestion pipeline as drag/drop.

Demo command:

```bash
cd apps/mcp-bridge
npm install
MCP_FILESYSTEM_ROOTS="$HOME/Documents/knowledge-demo" npm run dev
```

## Priority 3: Downloadable MCP Connector

Owner: Developer 1, optional frontend support by Developer 3

Best hackathon implementation: provide a downloadable starter script plus an `npx` command. Do not build a native desktop app during the hackathon.

Recommended UX:

1. User clicks "Connect local files".
2. Frontend shows:
   - Step 1: download connector script
   - Step 2: run command
   - Step 3: paste connector URL or use default `http://localhost:8790`
3. Backend checks connector health.

Implementation options:

### Option A: Download Shell Script

Add API endpoint:

```text
GET /downloads/filesystem-connector.sh
```

It returns a shell script that:

- asks user for a folder path, or accepts one argument
- runs `npx -y knowledge-swarm-mcp-bridge /that/folder`
- prints `http://localhost:8790`

This is easiest for demo, but shell scripts are macOS/Linux oriented.

### Option B: Download ZIP

Add API endpoint:

```text
GET /downloads/knowledge-swarm-connector.zip
```

The ZIP contains:

- `start-mac-linux.sh`
- `start-windows.ps1`
- `README.txt`

This is more polished and still hackathon-feasible.

### Option C: Publish npm Package

Package `apps/mcp-bridge` as:

```bash
npx knowledge-swarm-mcp-bridge "$HOME/Documents/demo"
```

This is the best long-term developer UX, but publishing takes more setup. For the hackathon, simulate it with a repo script or local package.

Recommendation:

- For demo: Option B is now implemented in the API.
- Frontend still needs a download button and setup instructions.

Important security copy:

- The connector only reads folders the user explicitly chooses.
- Do not ask users to expose their whole home directory.
- The connector runs locally on `localhost`.

## Priority 4: Node Click QA

Owner: Developer 2 + Developer 3

Tasks:

- Frontend node detail panel:
  - node label
  - type
  - properties
  - connected edges
  - source snippets
  - question input
- Backend/orchestrator endpoint for node question:
  - `POST /runs/:runId/nodes/:nodeId/question`
- Answer strategy:
  - retrieve node context from graph
  - retrieve source snippets/files
  - answer from local data first
  - use `/search` only if local data is insufficient
  - append new discovered triples to graph

## Priority 5: Supabase Production Check

Owner: Developer 1

Tasks:

- Apply migration in Supabase SQL Editor.
- Confirm Realtime tables are enabled.
- Verify inserts:
  - run
  - agent event
  - raw triples
  - sources
  - edge-source links
- Confirm frontend can subscribe through SSE at minimum.

SSE is enough for demo. Supabase Realtime is a backup/bonus.

## Priority 6: Search Budget Guard

Owner: Developer 1 + Developer 2

Tasks:

- Keep `SEARCH_MAX_RESULTS=5`.
- Do not call Brave during ingestion.
- Only call Brave for node-level "research more" or web fallback.
- Add simple in-memory cache keyed by query if time allows.

## Suggested Demo Script

1. Open frontend.
2. Show "Connect local files" and "Upload files" options.
3. Use drag/drop with prepared demo files.
4. Start ingestion.
5. Graph grows live.
6. Click a company/person node.
7. Ask: "What risks are connected to this company?"
8. System answers from local graph/sources.
9. Click "Research more online".
10. One Brave query expands graph with a new sourced relationship.

## What To Tell Developers

Developer 2:

- Own extraction and node-question logic.
- Use `/chunks` and `/raw-triples`.
- Treat MCP and upload as equivalent text sources.

Developer 3:

- Own upload/MCP connection UX and graph interaction.
- Do not wait for perfect MCP; drag/drop must work.
- Use SSE as the live update source.

Developer 1:

- Own Supabase, SSE, MCP bridge, connector download, and search config.
- Do not spend too long on native desktop packaging.
