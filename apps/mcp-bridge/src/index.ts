import express from 'express';
import cors from 'cors';
import { listTools, callTool, shutdown } from './mcp-client';

const app = express();
const port = parseInt(process.env.PORT || '8790', 10);

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mcp-bridge' });
});

app.get('/tools/list', async (_req, res) => {
  try {
    const tools = await listTools();
    res.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list tools';
    console.error('Error listing tools:', message);
    res.status(500).json({ error: message });
  }
});

app.post('/tools/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body as { name?: string; arguments?: Record<string, unknown> };

    if (!name) {
      return res.status(400).json({ error: 'Missing "name" field' });
    }

    const result = await callTool(name, args || {});
    res.json({ content: result.content, isError: result.isError });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool call failed';
    console.error('Error calling tool:', message);

    if (message.includes('not provided')) {
      return res.status(400).json({ error: message });
    }

    res.status(500).json({
      content: [{ type: 'text', text: message }],
      isError: true,
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

app.listen(port, async () => {
  console.log(`MCP Bridge running on http://localhost:${port}`);
  try {
    await listTools();
    console.log('[mcp-bridge] Ready');
  } catch (err) {
    console.error('[mcp-bridge] Failed to initialize:', err instanceof Error ? err.message : err);
  }
});
