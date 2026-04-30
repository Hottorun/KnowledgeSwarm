import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';

let _client: Client | null = null;
let _initialized = false;

export async function getMcpClient(): Promise<Client> {
  if (_client && _initialized) {
    return _client;
  }

  if (!_client) {
    const roots = parseFilesystemRoots();
    console.log(`[mcp-bridge] Starting filesystem MCP server with roots: ${roots.join(', ')}`);

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@latest', ...roots],
    });

    _client = new Client(
      { name: 'knowledge-swarm-mcp-bridge', version: '0.1.0' },
      { capabilities: {} }
    );

    await _client.connect(transport);
    _initialized = true;
    console.log('[mcp-bridge] MCP client connected');
  }

  return _client;
}

export async function listTools() {
  const client = await getMcpClient();
  const result = await client.listTools();
  return result.tools;
}

export async function callTool(name: string, args: Record<string, unknown>) {
  const client = await getMcpClient();
  const result = await client.request(
    {
      method: 'tools/call',
      params: { name, arguments: args },
    },
    CallToolResultSchema
  );
  return result;
}

function parseFilesystemRoots(): string[] {
  const envRoots = process.env.MCP_FILESYSTEM_ROOTS;
  if (envRoots) {
    return envRoots.split(',').map(s => normalizeRoot(s.trim())).filter(Boolean);
  }

  const cliRoots = process.argv.slice(2);
  if (cliRoots.length > 0) {
    return cliRoots.map(root => normalizeRoot(root));
  }

  throw new Error('No filesystem roots provided. Set MCP_FILESYSTEM_ROOTS env var or pass paths as CLI args');
}

function normalizeRoot(root: string): string {
  return fs.realpathSync(path.resolve(root));
}

export async function shutdown() {
  if (_client) {
    await _client.close();
    _client = null;
    _initialized = false;
    console.log('[mcp-bridge] MCP client closed');
  }
}
