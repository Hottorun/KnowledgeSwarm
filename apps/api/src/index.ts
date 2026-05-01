import express from 'express';
import cors from 'cors';
import { config, isSupabaseConfigured, isSearchConfigured } from './config';
import { testSupabaseConnection } from './supabase';
import { isOpenAIConfigured } from './services/ai';
import runsRouter from './routes/runs';
import searchRouter from './routes/search';
import demoRouter from './routes/demo';
import downloadsRouter from './routes/downloads';
import mcpRouter from './routes/mcp';
import aiRouter from './routes/ai';

const app = express();

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/health', async (_req, res) => {
  const search = isSearchConfigured();
  let supabaseOk = isSupabaseConfigured();

  if (supabaseOk) {
    supabaseOk = await testSupabaseConnection();
  }

  res.json({
    ok: true,
    service: 'knowledge-swarm-api',
    integrations: {
      supabase: supabaseOk,
      search: search.tavily || search.brave,
      mcp: !!config.mcpServerUrl,
      openai: isOpenAIConfigured(),
    },
  });
});

app.use('/runs', runsRouter);
app.use('/search', searchRouter);
app.use('/demo', demoRouter);
app.use('/downloads', downloadsRouter);
app.use('/mcp', mcpRouter);
app.use('/ai', aiRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Knowledge Swarm API running on http://localhost:${config.port}`);
  console.log(`CORS origins: ${config.corsOrigins.join(', ')}`);
  console.log(`Supabase: ${isSupabaseConfigured() ? 'configured' : 'not configured (local mode)'}`);
  const search = isSearchConfigured();
  console.log(`Search: ${search.tavily ? 'Tavily' : search.brave ? 'Brave' : 'not configured'}`);
  console.log(`OpenAI: ${isOpenAIConfigured() ? 'configured' : 'not configured (set via POST /ai/key)'}`);
});
