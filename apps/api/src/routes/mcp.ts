import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { mcpListTools, mcpListAllowedDirectories, mcpListDirectory, mcpReadFile, mcpSearchFiles } from '../services/mcp';

const router = Router();

const listDirectorySchema = z.object({
  path: z.string().min(1),
});

const readFileSchema = z.object({
  path: z.string().min(1),
});

const searchFilesSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1),
});

router.get('/health', async (_req: Request, res: Response) => {
  if (!config.mcpServerUrl) {
    return res.status(503).json({ ok: false, error: 'MCP_SERVER_URL not configured' });
  }

  try {
    const response = await fetch(`${config.mcpServerUrl}/health`);
    const data = await response.json() as unknown;
    return res.status(response.ok ? 200 : 502).json({ ok: response.ok, bridge: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'MCP bridge health check failed';
    return res.status(502).json({ ok: false, error: message });
  }
});

router.get('/tools', async (_req: Request, res: Response) => {
  const tools = await mcpListTools();
  return res.json({ tools });
});

router.get('/allowed-directories', async (_req: Request, res: Response) => {
  try {
    return res.json(await mcpListAllowedDirectories());
  } catch (err) {
    return handleMcpError(res, err);
  }
});

router.post('/list-directory', async (req: Request, res: Response) => {
  try {
    const { path } = listDirectorySchema.parse(req.body);
    return res.json(await mcpListDirectory(path));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post('/read-file', async (req: Request, res: Response) => {
  try {
    const { path } = readFileSchema.parse(req.body);
    return res.json(await mcpReadFile(path));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post('/search-files', async (req: Request, res: Response) => {
  try {
    const { path, pattern } = searchFilesSchema.parse(req.body);
    return res.json(await mcpSearchFiles(path, pattern));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

function handleRouteError(res: Response, err: unknown) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid input', details: err.errors });
  }

  return handleMcpError(res, err);
}

function handleMcpError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : 'MCP request failed';
  return res.status(502).json({ error: message });
}

export default router;
