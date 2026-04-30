import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { broadcast } from '../sse';
import { persistTriple } from '../services/graph';

const router = Router();

const seedSchema = z.object({
  runId: z.string().uuid().optional(),
});

router.post('/seed', async (req: Request, res: Response) => {
  console.log('[DEMO] Seed endpoint called — dev-only');

  try {
    const { runId: providedRunId } = seedSchema.parse(req.body);
    const runId = providedRunId || crypto.randomUUID();

    if (!providedRunId) {
      console.log(`[DEMO] No runId provided, generated ${runId}`);
    }

    broadcast({ event: 'agent.step', data: { runId, agentName: 'FinanceAgent', eventType: 'started', message: 'Starting research on battery market' } });
    await sleep(300);

    await persistTriple(runId, {
      subject: { id: 'company:acme', label: 'Acme Corp', type: 'Company', properties: { ticker: 'ACME', sector: 'Technology' } },
      predicate: 'acquired',
      object: { id: 'company:beta', label: 'Beta Inc', type: 'Company', properties: { ticker: 'BETA', sector: 'Energy Storage' } },
      confidence: 0.92,
      sources: [{ url: 'https://example.com/acme-beta', title: 'Acme Corp Acquires Beta Inc', snippet: 'Acme Corp announced the acquisition of Beta Inc for $2.1B.' }],
      properties: { date: '2026-03-15' },
    });
    await sleep(200);

    await persistTriple(runId, {
      subject: { id: 'company:beta', label: 'Beta Inc', type: 'Company', properties: {} },
      predicate: 'specializes_in',
      object: { id: 'market:solid-state-batteries', label: 'Solid-State Batteries', type: 'Market', properties: { growth_rate: '34% CAGR' } },
      confidence: 0.87,
      sources: [{ url: 'https://example.com/beta-tech', title: 'Beta Inc Technology Overview', snippet: 'Leading solid-state battery manufacturer.' }],
      properties: {},
    });
    await sleep(200);

    broadcast({ event: 'node.created', data: { runId, node: { id: 'person:jane-chen', label: 'Jane Chen', type: 'Person', properties: { role: 'CEO, Beta Inc' } } } });
    await sleep(200);

    await persistTriple(runId, {
      subject: { id: 'person:jane-chen', label: 'Jane Chen', type: 'Person', properties: { role: 'CEO, Beta Inc' } },
      predicate: 'leads',
      object: { id: 'company:beta', label: 'Beta Inc', type: 'Company', properties: {} },
      confidence: 0.95,
      properties: {},
    });
    await sleep(200);

    broadcast({ event: 'agent.step', data: { runId, agentName: 'FinanceAgent', eventType: 'completed', message: 'Research complete, 3 nodes and 3 edges extracted' } });

    return res.json({
      ok: true,
      runId,
      seeded: { nodes: 4, edges: 3, sources: 2, agentEvents: 2 },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('[DEMO] Seed error:', err);
    return res.status(500).json({ error: 'Seed failed' });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default router;
