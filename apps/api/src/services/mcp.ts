import { config } from '../config';

export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callMcpServer(tool: McpToolCall, mcpServerUrl?: string): Promise<McpToolResult> {
  const serverUrl = mcpServerUrl || config.mcpServerUrl;
  if (!serverUrl) {
    throw new Error('MCP_SERVER_URL not configured');
  }

  const response = await fetch(`${serverUrl}/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: tool.name,
      arguments: tool.arguments || {},
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP server error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<McpToolResult>;
}

export async function mcpSearch(query: string, mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'search',
    arguments: { query },
  }, mcpServerUrl);
}

export async function mcpFetch(url: string, mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'fetch',
    arguments: { url },
  }, mcpServerUrl);
}

export async function mcpListTools(mcpServerUrl?: string): Promise<string[]> {
  const serverUrl = mcpServerUrl || config.mcpServerUrl;
  if (!serverUrl) {
    return [];
  }

  try {
    const response = await fetch(`${serverUrl}/tools/list`);
    if (!response.ok) return [];
    const data = await response.json() as { tools?: Array<{ name?: unknown }> };
    return (data.tools || []).map((t: Record<string, unknown>) => t.name as string);
  } catch {
    return [];
  }
}

export async function mcpListDirectory(path: string, mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'list_directory',
    arguments: { path },
  }, mcpServerUrl);
}

export async function mcpReadFile(path: string, mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'read_file',
    arguments: { path },
  }, mcpServerUrl);
}

export async function mcpReadMultipleFiles(paths: string[], mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'read_multiple_files',
    arguments: { paths },
  }, mcpServerUrl);
}

export async function mcpSearchFiles(basePath: string, pattern: string, mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'search_files',
    arguments: { path: basePath, pattern },
  }, mcpServerUrl);
}

export async function mcpListAllowedDirectories(mcpServerUrl?: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'list_allowed_directories',
    arguments: {},
  }, mcpServerUrl);
}
