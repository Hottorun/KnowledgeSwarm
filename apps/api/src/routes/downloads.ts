import { Router } from 'express';
import { createConnectorZip } from '../services/connectorBundle';

const router = Router();

router.get('/knowledge-swarm-connector.zip', (_req, res) => {
  const zip = createConnectorZip();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-swarm-connector.zip"');
  res.setHeader('Content-Length', zip.length);
  res.send(zip);
});

router.get('/filesystem-connector.sh', (_req, res) => {
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="start-knowledge-swarm-connector.sh"');
  res.send(`#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash start-knowledge-swarm-connector.sh /path/to/allowed/folder"
  exit 1
fi

echo "Download the full connector ZIP from /downloads/knowledge-swarm-connector.zip for the no-install connector."
echo "For repo-local development, run:"
echo "  cd apps/mcp-bridge && MCP_FILESYSTEM_ROOTS=\\"$1\\" npm run dev"
`);
});

export default router;
