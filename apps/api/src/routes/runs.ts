import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getSupabase } from '../supabase';
import { addClient, broadcast } from '../sse';
import { persistTriple } from '../services/graph';

const router = Router();

const createRunSchema = z.object({
  prompt: z.string().min(1),
});

const agentEventSchema = z.object({
  agentName: z.string(),
  eventType: z.string(),
  message: z.string().optional(),
  payload: z.record(z.unknown()).optional().default({}),
});

const tripleSchema = z.object({
  agentName: z.string().optional(),
  triples: z.array(z.object({
    subject: z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      properties: z.record(z.unknown()).optional().default({}),
    }),
    predicate: z.string(),
    object: z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
      properties: z.record(z.unknown()).optional().default({}),
    }),
    confidence: z.number().optional(),
    sources: z.array(z.object({
      url: z.string(),
      title: z.string().optional(),
      snippet: z.string().optional(),
    })).optional().default([]),
    properties: z.record(z.unknown()).optional().default({}),
  })),
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { prompt } = createRunSchema.parse(req.body);
    const supabase = getSupabase();

    if (supabase) {
      const { data, error } = await supabase
        .from('research_runs')
        .insert({ prompt, status: 'running' })
        .select()
        .single();

      if (error) {
        console.error('Supabase error creating run:', error);
        return res.status(500).json({ error: 'Failed to create run' });
      }

      broadcast({ event: 'run.status', data: { runId: data.id, status: 'running', prompt } });
      return res.json({ runId: data.id });
    }

    const runId = crypto.randomUUID();
    console.log(`[local] Created run ${runId} (Supabase not configured)`);
    broadcast({ event: 'run.status', data: { runId, status: 'running', prompt } });
    return res.json({ runId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error creating run:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:runId/events', (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  console.log(`SSE client connected for run ${runId}`);
  const clientId = addClient(runId, res);
  res.write(`event: run.status\ndata: ${JSON.stringify({
    type: 'run.status',
    runId,
    timestamp: new Date().toISOString(),
    payload: { status: 'connected', clientId },
  })}\n\n`);
});

router.post('/:runId/agent-events', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { agentName, eventType, message, payload } = agentEventSchema.parse(req.body);

    const supabase = getSupabase();
    if (supabase) {
      const { error } = await supabase.from('agent_events').insert({
        run_id: runId,
        agent_name: agentName,
        event_type: eventType,
        message: message || '',
        payload: payload || {},
      });
      if (error) {
        console.error('Supabase error inserting agent event:', error);
      }
    }

    broadcast({ event: 'agent.step', data: { runId, agentName, eventType, message, payload } });
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error processing agent event:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:runId/triples', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { agentName, triples } = tripleSchema.parse(req.body);

    for (const triple of triples) {
      await persistTriple(runId, {
        agentName,
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
        confidence: triple.confidence,
        sources: triple.sources,
        properties: triple.properties,
      });
    }

    return res.json({ ok: true, persisted: triples.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error processing triples:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
