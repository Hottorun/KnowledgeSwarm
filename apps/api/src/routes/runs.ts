import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getSupabase } from '../supabase';
import { addClient, broadcast } from '../sse';
import { persistTriple } from '../services/graph';
import { chunkText, normalizeExtractedTriples } from '../services/ingestion';
import { setRunRootContext } from '../services/ai';

const router = Router();

const createRunSchema = z.object({
  prompt: z.string().min(1).optional().default('Untitled knowledge graph'),
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

const rawTripleSchema = z.object({
  agentName: z.string().optional(),
  triples: z.array(z.object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    subjectType: z.string().optional(),
    objectType: z.string().optional(),
    confidence: z.number().optional(),
    source: z.object({
      url: z.string().optional(),
      title: z.string().optional(),
      snippet: z.string().optional(),
      documentName: z.string().optional(),
      page: z.number().optional(),
      row: z.number().optional(),
    }).optional(),
    properties: z.record(z.unknown()).optional().default({}),
  })),
});

const chunkTextSchema = z.object({
  text: z.string().min(1),
  chunkSize: z.number().int().positive().max(2000).optional(),
  overlap: z.number().int().nonnegative().max(500).optional(),
});

const textUploadSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1),
    content: z.string().min(1),
    mimeType: z.string().optional(),
  })).min(1).max(25),
  chunkSize: z.number().int().positive().max(2000).optional(),
  overlap: z.number().int().nonnegative().max(500).optional(),
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

      setRunRootContext(data.id, prompt);
      broadcast({ event: 'run.status', data: { runId: data.id, status: 'running', prompt } });
      return res.json({ runId: data.id });
    }

    const runId = crypto.randomUUID();
    setRunRootContext(runId, prompt);
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
        console.error('Supabase error inserting agent event:', error.message);
        return res.status(500).json({ error: `Failed to persist agent event: ${error.message}` });
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
    const message = err instanceof Error ? err.message : 'Unknown error processing triples';
    console.error('Error processing triples:', message);
    return res.status(500).json({ error: message });
  }
});

router.post('/:runId/raw-triples', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { agentName, triples } = rawTripleSchema.parse(req.body);
    const normalizedTriples = normalizeExtractedTriples(agentName || 'IngestionAgent', triples);

    for (const triple of normalizedTriples) {
      await persistTriple(runId, triple);
    }

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: agentName || 'IngestionAgent',
        eventType: 'ingestion.normalized',
        message: `Normalized and persisted ${normalizedTriples.length} extracted triples`,
        payload: { received: triples.length, persisted: normalizedTriples.length },
      },
    });

    return res.json({ ok: true, received: triples.length, persisted: normalizedTriples.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error processing raw triples';
    console.error('Error processing raw triples:', message);
    return res.status(500).json({ error: message });
  }
});

router.post('/:runId/chunks', (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { text, chunkSize, overlap } = chunkTextSchema.parse(req.body);
    const chunks = chunkText(text, chunkSize || 500, overlap || 50);

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'IngestionAgent',
        eventType: 'ingestion.chunked',
        message: `Prepared ${chunks.length} text chunks for extraction`,
        payload: { chunks: chunks.length },
      },
    });

    return res.json({ ok: true, chunks });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error chunking text';
    console.error('Error chunking text:', message);
    return res.status(500).json({ error: message });
  }
});

router.post('/:runId/uploads/text', (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { files, chunkSize, overlap } = textUploadSchema.parse(req.body);
    const normalizedChunkSize = chunkSize || 500;
    const normalizedOverlap = overlap || 50;

    const documents = files.map(file => ({
      name: file.name,
      mimeType: file.mimeType || 'text/plain',
      chunks: chunkText(file.content, normalizedChunkSize, normalizedOverlap),
    }));

    const totalChunks = documents.reduce((sum, document) => sum + document.chunks.length, 0);

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'IngestionAgent',
        eventType: 'ingestion.uploaded',
        message: `Received ${files.length} uploaded text files and prepared ${totalChunks} chunks`,
        payload: {
          files: files.map(file => ({ name: file.name, mimeType: file.mimeType || 'text/plain' })),
          chunks: totalChunks,
        },
      },
    });

    return res.json({ ok: true, files: documents.length, chunks: totalChunks, documents });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error processing uploaded text';
    console.error('Error processing uploaded text:', message);
    return res.status(500).json({ error: message });
  }
});

export default router;
