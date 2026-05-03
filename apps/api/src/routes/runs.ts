import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getSupabase } from '../supabase';
import { addClient, broadcast } from '../sse';
import { persistTriple, loadRunGraph, LoadedRunGraph, GraphNode } from '../services/graph';
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

// Snapshot endpoint — lets the frontend rehydrate a run on reload without
// replaying every SSE event. Returns nodes, edges, and sources as a
// self-contained graph. Returns 503 when Supabase isn't configured (local dev
// without a DB has no snapshot to serve), and 404 when the runId isn't found.
router.get('/:runId/graph', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const snapshot = await loadRunGraph(runId);
    if (snapshot === null && !getSupabase()) {
      return res.status(503).json({ error: 'Supabase not configured; graph snapshot unavailable in local-only mode' });
    }
    if (!snapshot) return res.status(404).json({ error: `Run ${runId} not found` });
    return res.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error loading run graph';
    console.error('Error loading run graph:', message);
    return res.status(500).json({ error: message });
  }
});

router.get('/:runId/presentation-graph', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const snapshot = await loadRunGraph(runId);
    if (snapshot === null && !getSupabase()) {
      return res.status(503).json({ error: 'Supabase not configured; presentation graph unavailable in local-only mode' });
    }
    if (!snapshot) return res.status(404).json({ error: `Run ${runId} not found` });
    return res.json(buildPresentationGraph(snapshot));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error loading presentation graph';
    console.error('Error loading presentation graph:', message);
    return res.status(500).json({ error: message });
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

function buildPresentationGraph(snapshot: LoadedRunGraph) {
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const centerNode = choosePresentationCenter(snapshot);
  const categories = snapshot.nodes
    .filter(node => node.type === 'Category' || node.properties.presentationRole === 'business_area')
    .map(node => ({
      ...node,
      documents: snapshot.edges
        .filter(edge => edge.source === node.id && edge.predicate === 'contains_document')
        .map(edge => nodeById.get(edge.target))
        .filter((related): related is GraphNode => related !== undefined && related.type === 'Document'),
    }));
  const documents = snapshot.nodes
    .filter(node => node.type === 'Document' || node.properties.presentationRole === 'document')
    .map(node => ({
      ...node,
      mentions: snapshot.edges
        .filter(edge => edge.source === node.id && edge.predicate === 'mentions')
        .map(edge => nodeById.get(edge.target))
        .filter((related): related is GraphNode => related !== undefined),
    }));
  const topFacts = snapshot.edges
    .filter(edge => !['has_business_area', 'contains_document', 'mentions'].includes(edge.predicate))
    .sort((a, b) => importanceOf(b.properties) - importanceOf(a.properties) || (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 40)
    .map(edge => ({
      edge,
      subject: nodeById.get(edge.source) ?? null,
      object: nodeById.get(edge.target) ?? null,
      sources: edge.sources ?? [],
    }));
  const crossLinks = snapshot.edges
    .filter(edge => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return false;
      if (source.type === 'Category' || target.type === 'Category') return false;
      if (source.type === 'Document' || target.type === 'Document') return false;
      return edge.predicate !== 'mentions';
    })
    .slice(0, 60);

  return {
    runId: snapshot.runId,
    prompt: snapshot.prompt,
    centerNode,
    categories,
    documents,
    topFacts,
    crossLinks,
  };
}

function choosePresentationCenter(snapshot: LoadedRunGraph): GraphNode | null {
  const explicit = snapshot.nodes.find(node => node.properties.presentationRole === 'main_entity');
  if (explicit) return explicit;

  const structural = new Set(
    snapshot.nodes
      .filter(node => node.type === 'Category' || node.type === 'Document')
      .map(node => node.id),
  );
  const degree = new Map<string, number>();
  for (const edge of snapshot.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return snapshot.nodes
    .filter(node => !structural.has(node.id))
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0]
    ?? snapshot.nodes[0]
    ?? null;
}

function importanceOf(properties: Record<string, unknown>): number {
  return typeof properties.importance === 'number' ? properties.importance : 0;
}

export default router;
