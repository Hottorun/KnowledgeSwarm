import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { mcpListTools, mcpListAllowedDirectories, mcpListDirectory, mcpReadFile, mcpSearchFiles } from '../services/mcp';

const router = Router();

const mcpServerUrlSchema = z.object({
  mcpServerUrl: z.string().url().optional(),
});

const listDirectorySchema = z.object({
  path: z.string().min(1),
  mcpServerUrl: z.string().url().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  mcpServerUrl: z.string().url().optional(),
});

const searchFilesSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1),
  mcpServerUrl: z.string().url().optional(),
});

router.post('/health', async (req: Request, res: Response) => {
  const mcpServerUrl = req.body.mcpServerUrl || config.mcpServerUrl;

  if (!mcpServerUrl) {
    return res.status(503).json({ ok: false, error: 'MCP_SERVER_URL not configured' });
  }

  console.log(`[mcp] Health check for: ${mcpServerUrl}`);

  try {
    // Try /health first, then fall back to /tools/list for MCP-compatible servers
    let response = await fetch(`${mcpServerUrl}/health`);
    
    if (!response.ok) {
      console.log(`[mcp] /health failed, trying /tools/list...`);
      // Fall back to tools/list which is standard MCP
      response = await fetch(`${mcpServerUrl}/tools/list`);
    }
    
    const data = await response.json() as unknown;
    console.log(`[mcp] Health check result:`, { ok: response.ok, data });
    return res.status(response.ok ? 200 : 502).json({ ok: response.ok, bridge: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'MCP bridge health check failed';
    console.error(`[mcp] Health check error:`, message);
    return res.status(502).json({ ok: false, error: message, mcpServerUrl });
  }
});

router.get('/tools', async (req: Request, res: Response) => {
  const mcpServerUrl = req.query.mcpServerUrl as string | undefined;
  const tools = await mcpListTools(mcpServerUrl);
  return res.json({ tools });
});

router.get('/allowed-directories', async (req: Request, res: Response) => {
  try {
    const mcpServerUrl = req.query.mcpServerUrl as string | undefined;
    return res.json(await mcpListAllowedDirectories(mcpServerUrl));
  } catch (err) {
    return handleMcpError(res, err);
  }
});

router.post('/list-directory', async (req: Request, res: Response) => {
  try {
    const { path, mcpServerUrl } = listDirectorySchema.parse(req.body);
    return res.json(await mcpListDirectory(path, mcpServerUrl));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post('/read-file', async (req: Request, res: Response) => {
  try {
    const { path, mcpServerUrl } = readFileSchema.parse(req.body);
    return res.json(await mcpReadFile(path, mcpServerUrl));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post('/search-files', async (req: Request, res: Response) => {
  try {
    const { path, pattern, mcpServerUrl } = searchFilesSchema.parse(req.body);
    return res.json(await mcpSearchFiles(path, pattern, mcpServerUrl));
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const { mcpServerUrl } = mcpServerUrlSchema.parse(req.body);
    const serverUrl = mcpServerUrl || config.mcpServerUrl;

    if (!serverUrl) {
      return res.status(503).json({ error: 'MCP_SERVER_URL not configured' });
    }

    console.log(`[mcp] read-all for: ${serverUrl}`);

    // Readable file extensions
    const READABLE_EXTENSIONS = /\.(txt|md|csv|json)$/i;
    const allFiles: Array<{ name: string; text: string }> = [];

    // Get allowed directories from health check or use roots from health response
    let dirs: string[] = [];
    try {
      const healthRes = await fetch(`${serverUrl}/health`);
      const healthData = await healthRes.json() as { roots?: string[] };
      dirs = healthData.roots || [];
      console.log(`[mcp] Using roots from health check:`, dirs);
    } catch {
      // Fall back to trying to list allowed directories
      try {
        const allowedDirs = await mcpListAllowedDirectories(serverUrl);
        dirs = allowedDirs.content?.[0]?.text?.split('\n').map(d => d.trim()).filter(Boolean) || [];
      } catch {
        return res.status(400).json({ error: 'Could not determine allowed directories. Make sure your MCP server returns "roots" in /health or supports list_allowed_directories.' });
      }
    }

    if (dirs.length === 0) {
      return res.status(400).json({ error: 'No allowed directories found.' });
    }

    // List and read files from each directory
    for (const dir of dirs) {
      try {
        console.log(`[mcp] Listing directory: ${dir}`);
        const listing = await mcpListDirectory(dir, serverUrl);
        
        // Parse the listing - handle various formats
        const rawListing = listing.content?.[0]?.text || '';
        console.log(`[mcp] Raw listing:`, rawListing);
        
        const filePaths = rawListing
          .split('\n')
          .map(line => {
            // Remove prefixes like [file], [dir], etc. and trim
            return line.replace(/\[.*?\]\s*/g, '').trim();
          })
          .filter(line => line && READABLE_EXTENSIONS.test(line))
          .map(line => {
            // If it's already an absolute path, return it (but still clean it);
            // otherwise prepend dir
            const cleaned = line.replace(/\[.*?\]\s*/g, '').trim();
            return cleaned.startsWith('/') ? cleaned : `${dir}/${cleaned}`;
          });

        console.log(`[mcp] Found files in ${dir}:`, filePaths);

        for (const filePath of filePaths) {
          try {
            console.log(`[mcp] Reading file: ${filePath}`);
            const fileContent = await mcpReadFile(filePath, serverUrl);
            const text = fileContent.content?.map(c => c.text).join('') ?? '';
            const name = filePath.split('/').pop() ?? filePath;
            allFiles.push({ name, text });
          } catch (err) {
            console.warn(`[mcp] Failed to read file ${filePath}:`, err);
          }
        }
      } catch (err) {
        console.warn(`[mcp] Failed to list directory ${dir}:`, err);
      }
    }

    if (allFiles.length === 0) {
      return res.status(400).json({ error: 'No readable files found. Make sure your MCP server has list_directory and read_file tools available.' });
    }

    console.log(`[mcp] Successfully read ${allFiles.length} files`);
    return res.json({
      content: allFiles.map(f => ({ type: 'text', text: `--- ${f.name} ---\n${f.text}` })),
      files: allFiles,
      filesCount: allFiles.length,
    });
  } catch (err) {
    console.error(`[mcp] read-all error:`, err);
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
