import dotenv from 'dotenv';
dotenv.config();

function parseCorsOrigins(raw: string | undefined): string[] {
  const defaults = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];
  const configured = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  return Array.from(new Set([...defaults, ...configured]));
}

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  searchMaxResults: parseInt(process.env.SEARCH_MAX_RESULTS || '5', 10),
  mcpServerUrl: process.env.MCP_SERVER_URL || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
};

export function isSupabaseConfigured(): boolean {
  return !!(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export function isSearchConfigured(): { tavily: boolean; brave: boolean } {
  return {
    tavily: !!config.tavilyApiKey,
    brave: !!config.braveSearchApiKey,
  };
}
