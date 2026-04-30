import { config } from '../config';

export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callMcpServer(tool: McpToolCall): Promise<McpToolResult> {
  if (!config.mcpServerUrl) {
    throw new Error('MCP_SERVER_URL not configured');
  }

  const response = await fetch(`${config.mcpServerUrl}/tools/call`, {
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

export async function mcpSearch(query: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'search',
    arguments: { query },
  });
}

export async function mcpFetch(url: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'fetch',
    arguments: { url },
  });
}

export async function mcpListTools(): Promise<string[]> {
  if (!config.mcpServerUrl) {
    return [];
  }

  try {
    const response = await fetch(`${config.mcpServerUrl}/tools/list`);
    if (!response.ok) return [];
    const data = await response.json() as { tools?: Array<{ name?: unknown }> };
    return (data.tools || []).map((t: Record<string, unknown>) => t.name as string);
  } catch {
    return [];
  }
}

export async function mcpListDirectory(path: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'list_directory',
    arguments: { path },
  });
}

export async function mcpReadFile(path: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'read_file',
    arguments: { path },
  });
}

export async function mcpReadMultipleFiles(paths: string[]): Promise<McpToolResult> {
  return callMcpServer({
    name: 'read_multiple_files',
    arguments: { paths },
  });
}

export async function mcpSearchFiles(basePath: string, pattern: string): Promise<McpToolResult> {
  return callMcpServer({
    name: 'search_files',
    arguments: { path: basePath, pattern },
  });
}

export async function mcpListAllowedDirectories(): Promise<McpToolResult> {
  return callMcpServer({
    name: 'list_allowed_directories',
    arguments: {},
  });
}
