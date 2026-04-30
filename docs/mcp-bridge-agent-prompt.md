# Prompt For Coding Agent: Local MCP Filesystem Bridge

We need a minimal local MCP bridge for the KnowledgeSwarm hackathon demo.

## Context

The official filesystem MCP server runs over stdio:

```bash
npx -y @modelcontextprotocol/server-filesystem@latest /allowed/folder
```

Our backend currently expects an HTTP bridge configured by:

```bash
MCP_SERVER_URL=http://localhost:8790
```

Existing backend adapter expects:

- `GET /tools/list`
- `POST /tools/call`

## Task

Create a minimal local connector under `apps/mcp-bridge` or `packages/mcp-bridge`.

It should:

1. Start an Express server on `PORT=8790` by default.
2. Connect to the official filesystem MCP server over stdio using the MCP TypeScript SDK.
3. Accept allowed filesystem roots from CLI args or env:
   - `MCP_FILESYSTEM_ROOTS=/path/one,/path/two`
4. Expose:
   - `GET /health`
   - `GET /tools/list`
   - `POST /tools/call`
5. Support at least:
   - `list_directory`
   - `read_file`
   - `read_multiple_files`
   - `search_files`
   - `list_allowed_directories`
6. Never expose arbitrary filesystem paths beyond the MCP server roots.
7. Add a run command:
   - `npm run dev -- /path/to/demo/folder`

## Constraints

- Keep it tiny.
- Do not change the main API contract unless required.
- Do not put secrets in git.
- Do not make repeated external API calls.
- If MCP SDK setup is too slow, create a documented mock bridge with the same HTTP endpoints that reads from an allowed local folder. The demo needs working ingestion more than protocol purity.

## Deliverables

- Files changed.
- How to run the bridge.
- Example curl calls.
- Exact limitations.
- Whether it uses real MCP SDK or a local mock bridge fallback.

