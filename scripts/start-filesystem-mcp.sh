#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash scripts/start-filesystem-mcp.sh /path/to/allowed/folder [/another/folder]"
  echo
  echo "Example:"
  echo "  bash scripts/start-filesystem-mcp.sh ~/Documents/demo-files"
  exit 1
fi

echo "Starting filesystem MCP server with allowed roots:"
for path in "$@"; do
  echo "  - $path"
done
echo
echo "This starts the official MCP filesystem server over stdio."
echo "It is meant to be launched by an MCP client/bridge, not opened in a browser."
echo

npx -y @modelcontextprotocol/server-filesystem@latest "$@"
