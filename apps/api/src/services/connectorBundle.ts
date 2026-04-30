import { createZip } from './zip';

export function createConnectorZip(): Buffer {
  return createZip([
    { name: 'README.txt', content: readmeText },
    { name: 'connector.js', content: connectorJs },
    { name: 'start-mac-linux.sh', content: startMacLinux },
    { name: 'start-windows.ps1', content: startWindows },
  ]);
}

const readmeText = `KnowledgeSwarm Local Files Connector

This connector lets KnowledgeSwarm read files from one folder you explicitly choose.
It runs locally on your machine at http://localhost:8790.

Requirements:
- Node.js 18 or newer

macOS/Linux:
  bash start-mac-linux.sh /path/to/your/folder

Windows PowerShell:
  ./start-windows.ps1 "C:\\path\\to\\your\\folder"

Security:
- Only the folder you pass to the script is readable.
- Do not pass your whole home directory.
- Stop the connector with Ctrl+C when you are done.

Health check:
  http://localhost:8790/health
`;

const startMacLinux = `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash start-mac-linux.sh /path/to/allowed/folder"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export MCP_FILESYSTEM_ROOTS="$1"
export PORT="\${PORT:-8790}"

echo "Starting KnowledgeSwarm local connector on http://localhost:$PORT"
echo "Allowed folder: $MCP_FILESYSTEM_ROOTS"
node "$SCRIPT_DIR/connector.js"
`;

const startWindows = `param(
  [Parameter(Mandatory=$true)]
  [string]$Folder
)

$env:MCP_FILESYSTEM_ROOTS = $Folder
if (-not $env:PORT) {
  $env:PORT = "8790"
}

Write-Host "Starting KnowledgeSwarm local connector on http://localhost:$env:PORT"
Write-Host "Allowed folder: $env:MCP_FILESYSTEM_ROOTS"
node "$PSScriptRoot\\connector.js"
`;

const connectorJs = `#!/usr/bin/env node
const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const port = Number(process.env.PORT || 8790);
const roots = parseRoots();

const tools = [
  {
    name: 'list_allowed_directories',
    description: 'List directories this connector can read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_directory',
    description: 'List files and folders under an allowed directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file under an allowed directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'read_multiple_files',
    description: 'Read multiple UTF-8 text files under allowed directories.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  },
  {
    name: 'search_files',
    description: 'Find files by filename substring under allowed directories.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, service: 'knowledge-swarm-local-connector', roots });
    }

    if (req.method === 'GET' && req.url === '/tools/list') {
      return sendJson(res, 200, { tools });
    }

    if (req.method === 'POST' && req.url === '/tools/call') {
      const body = await readJson(req);
      const result = await callTool(body.name, body.arguments || {});
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, {
      content: [{ type: 'text', text: error.message || 'Connector error' }],
      isError: true,
    });
  }
});

server.listen(port, () => {
  console.log('KnowledgeSwarm local connector running on http://localhost:' + port);
  console.log('Allowed roots:');
  for (const root of roots) console.log('  - ' + root);
});

async function callTool(name, args) {
  if (name === 'list_allowed_directories') {
    return textResult(roots.join('\\n'));
  }

  if (name === 'list_directory') {
    const target = resolveAllowed(args.path || roots[0]);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return textResult(entries.map(entry => (entry.isDirectory() ? '[dir] ' : '[file] ') + entry.name).join('\\n'));
  }

  if (name === 'read_file') {
    const target = resolveAllowed(args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Path is not a file');
    if (stat.size > 2_000_000) throw new Error('File is too large for demo connector');
    return textResult(await fs.readFile(target, 'utf8'));
  }

  if (name === 'read_multiple_files') {
    if (!Array.isArray(args.paths)) throw new Error('paths must be an array');
    const parts = [];
    for (const filePath of args.paths.slice(0, 20)) {
      const target = resolveAllowed(filePath);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      parts.push('--- ' + target + ' ---\\n' + await fs.readFile(target, 'utf8'));
    }
    return textResult(parts.join('\\n\\n'));
  }

  if (name === 'search_files') {
    const query = String(args.query || '').toLowerCase();
    if (!query) throw new Error('query is required');
    const matches = [];
    for (const root of roots) {
      await walk(root, async filePath => {
        if (path.basename(filePath).toLowerCase().includes(query)) matches.push(filePath);
      });
    }
    return textResult(matches.slice(0, 100).join('\\n'));
  }

  throw new Error('Unknown tool: ' + name);
}

function parseRoots() {
  const raw = process.env.MCP_FILESYSTEM_ROOTS || process.argv.slice(2).join(',');
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (values.length === 0) {
    console.error('Usage: node connector.js /path/to/allowed/folder');
    process.exit(1);
  }
  return values.map(value => path.resolve(value));
}

function resolveAllowed(inputPath) {
  if (!inputPath) throw new Error('path is required');
  const target = path.resolve(String(inputPath));
  const allowed = roots.some(root => target === root || target.startsWith(root + path.sep));
  if (!allowed) throw new Error('Path is outside allowed connector roots');
  return target;
}

async function walk(dir, onFile) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walk(fullPath, onFile);
    } else {
      await onFile(fullPath);
    }
  }
}

function textResult(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(status === 204 ? undefined : JSON.stringify(payload));
}
`;
