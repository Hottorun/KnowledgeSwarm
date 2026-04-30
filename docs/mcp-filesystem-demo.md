# Filesystem MCP Demo

## What We Can Demo

For the hackathon, the simplest credible MCP demo is:

1. User chooses a local folder.
2. A local filesystem MCP server exposes only that folder.
3. Our backend/orchestrator reads selected files through a local MCP bridge.
4. Extracted text is converted into graph triples.
5. The frontend renders the graph live.

The official filesystem MCP server is available as an npm package:

- `@modelcontextprotocol/server-filesystem`
- Docs: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- npm: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem

It supports controlled access to specific allowed directories. This is exactly what we want for a demo.

## Important Constraint

Most local MCP servers, including the official filesystem server, speak MCP over **stdio**. That means they are normally launched by an MCP client like Claude Desktop or a local bridge process.

Our current backend config has:

```bash
MCP_SERVER_URL=
```

That assumes an HTTP/SSE bridge exists in front of the MCP server. The official filesystem server itself is not an HTTP server you can call directly from the browser.

So there are two options:

## Option A: Fastest Reliable Demo

Use drag/drop upload as the primary demo path and show MCP as the connection option/instructions.

This is safest because browser file upload works immediately:

- User drags files into Lovable.
- Frontend sends file contents or parsed text to the orchestrator.
- Orchestrator extracts triples.
- Backend persists/streams graph.

MCP appears as:

- "Connect local MCP source"
- Shows command/instructions
- May be marked "local connector required" if not fully wired

## Option B: Real Local MCP Demo

Add a small local connector process:

```text
filesystem MCP server over stdio
        |
        v
local MCP HTTP bridge on localhost
        |
        v
KnowledgeSwarm backend via MCP_SERVER_URL
```

The bridge should expose simple HTTP endpoints:

- `GET /tools/list`
- `POST /tools/call`

That matches the current backend adapter in `apps/api/src/services/mcp.ts`.

## Start The Filesystem MCP Server

Run:

```bash
bash scripts/start-filesystem-mcp.sh /absolute/path/to/demo/files
```

Example:

```bash
bash scripts/start-filesystem-mcp.sh "$HOME/Documents/knowledge-demo"
```

This command uses:

```bash
npx -y @modelcontextprotocol/server-filesystem@latest /allowed/folder
```

Only pass folders that are safe for the demo. Do not pass your entire home directory.

## Downloadable Connector Idea

Yes, MCP servers/connectors can be made easy for users:

- npm package: `npx knowledge-swarm-connector ~/Documents/demo`
- Docker image: `docker run ... knowledge-swarm-connector`
- desktop app later: a small tray app that lets users choose folders

For this hackathon, the best version is an npm/npx local connector because it is fast and cross-platform enough for technical judges.

The connector would:

1. Ask for or receive allowed directories.
2. Start the filesystem MCP server.
3. Expose a localhost HTTP bridge.
4. Print a URL/token for the frontend/backend.

Example future command:

```bash
npx knowledge-swarm-connector --filesystem "$HOME/Documents/demo" --port 8790
```

Then backend env:

```bash
MCP_SERVER_URL=http://localhost:8790
```

## Frontend Copy

Use this user-facing copy:

```text
Connect a local folder with MCP

Run this command in your terminal, then paste the connector URL here:

bash scripts/start-filesystem-mcp.sh /path/to/your/folder

For this demo, only files inside the selected folder are readable.
```

If the real bridge is not finished, show:

```text
MCP connector is available for local setup. For the live demo, drag files here to build the graph immediately.
```

## What To Tell The Team

Developer 1:

- Owns local MCP bridge or fallback upload path.
- Should not spend too long on MCP protocol internals if drag/drop is not done.

Developer 2:

- Should accept file text from either MCP or drag/drop.
- Should output raw triples to `/runs/:runId/raw-triples`.

Developer 3:

- Should build both UI paths:
  - MCP connection panel
  - drag/drop upload panel
- Drag/drop should remain the guaranteed demo path.

