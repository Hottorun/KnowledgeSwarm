import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { performSearch } from '../services/search';

const router = Router();

const searchSchema = z.object({
  query: z.string().min(1),
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { query } = searchSchema.parse(req.body);

    const results = await performSearch(query);
    return res.json(results);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }

    const message = err instanceof Error ? err.message : 'Search failed';
    const normalizedMessage = message.toLowerCase();
    if (normalizedMessage.includes('not configured') || normalizedMessage.includes('no search api key')) {
      return res.status(503).json({ error: message, hint: 'Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY in .env' });
    }

    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
