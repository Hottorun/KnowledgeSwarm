import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  setRuntimeOpenAIKey,
  isOpenAIConfigured,
  validateKeyFormat,
  verifyOpenAIKey,
  extractTriplesFromChunk,
  expandSubtree,
} from '../services/ai';
import { chunkText, normalizeExtractedTriples } from '../services/ingestion';
import { persistTriple } from '../services/graph';
import { broadcast } from '../sse';

const router = Router();

// ── API key management ───────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: isOpenAIConfigured() });
});

const setKeySchema = z.object({
  apiKey: z.string().min(1),
  verify: z.boolean().optional().default(false),
});

router.post('/key', async (req: Request, res: Response) => {
  try {
    const { apiKey, verify } = setKeySchema.parse(req.body);

    if (!validateKeyFormat(apiKey)) {
      return res.status(400).json({ error: 'Invalid API key format. Expected sk-...' });
    }

    if (verify) {
      const valid = await verifyOpenAIKey(apiKey);
      if (!valid) {
        return res.status(400).json({ error: 'OpenAI rejected the key. Check that it is active and has credits.' });
      }
    }

    setRuntimeOpenAIKey(apiKey);
    console.log('[ai] OpenAI API key set at runtime');
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// ── Extraction endpoint ───────────────────────────────────────────────────────
// POST /ai/runs/:runId/extract
// Accepts pre-chunked text or raw text (will chunk it here), runs LLM extraction,
// persists raw-triples, and streams progress via SSE.

const extractSchema = z.object({
  // Option A: pass pre-chunked data
  chunks: z.array(z.object({
    index: z.number(),
    text: z.string().min(1),
  })).optional(),
  // Option B: pass raw text and we chunk it
  text: z.string().optional(),
  chunkSize: z.number().int().positive().max(2000).optional(),
  overlap: z.number().int().nonnegative().max(500).optional(),
  documentName: z.string().optional(),
});

router.post('/runs/:runId/extract', async (req: Request, res: Response) => {
  if (!isOpenAIConfigured()) {
    return res.status(503).json({ error: 'OpenAI API key not configured. POST /ai/key first.' });
  }

  try {
    const runId = String(req.params.runId);
    const body = extractSchema.parse(req.body);
    const documentName = body.documentName || 'uploaded-document';

    let chunks: Array<{ index: number; text: string }>;
    if (body.chunks && body.chunks.length > 0) {
      chunks = body.chunks;
    } else if (body.text) {
      chunks = chunkText(body.text, body.chunkSize || 500, body.overlap || 50);
    } else {
      return res.status(400).json({ error: 'Provide either chunks or text' });
    }

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'ExtractionAgent',
        eventType: 'extraction.started',
        message: `Starting AI extraction on ${chunks.length} chunk(s) from "${documentName}"`,
        payload: { chunks: chunks.length, documentName },
      },
    });

    const allTriples: ReturnType<typeof normalizeExtractedTriples> = [];
    let errors = 0;

    for (const chunk of chunks) {
      const result = await extractTriplesFromChunk(chunk.text, chunk.index, documentName);

      if (result.error) {
        errors++;
        broadcast({
          event: 'agent.step',
          data: {
            runId,
            agentName: 'ExtractionAgent',
            eventType: 'extraction.chunk.error',
            message: `Chunk ${chunk.index} failed: ${result.error}`,
            payload: { chunkIndex: chunk.index, error: result.error },
          },
        });
        continue;
      }

      if (result.triples.length === 0) continue;

      const normalized = normalizeExtractedTriples('ExtractionAgent', result.triples);

      for (const triple of normalized) {
        await persistTriple(runId, triple);
        allTriples.push(triple);
      }

      broadcast({
        event: 'agent.step',
        data: {
          runId,
          agentName: 'ExtractionAgent',
          eventType: 'extraction.chunk.done',
          message: `Chunk ${chunk.index}: extracted ${result.triples.length} relationship(s)`,
          payload: { chunkIndex: chunk.index, extracted: result.triples.length },
        },
      });
    }

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'ExtractionAgent',
        eventType: 'extraction.completed',
        message: `Extraction complete: ${allTriples.length} relationship(s) added to graph from "${documentName}"`,
        payload: { total: allTriples.length, errors, documentName },
      },
    });

    return res.json({
      ok: true,
      chunksProcessed: chunks.length,
      triplesExtracted: allTriples.length,
      errors,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in extract endpoint:', message);
    return res.status(500).json({ error: message });
  }
});

// ── Subtree expansion endpoint ────────────────────────────────────────────────
// POST /ai/runs/:runId/expand-subtree
//
// The frontend sends the full subtree the user clicked (root node + all
// descendant nodes and edges). The AI generates targeted web search queries
// from the subtree content, searches the web, synthesizes the results into
// new SPO triples, and persists them — expanding that branch in the graph.

const subtreeNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.string().optional().default('Entity'),
});

const subtreeEdgeSchema = z.object({
  subjectLabel: z.string().min(1),
  predicate: z.string().min(1),
  objectLabel: z.string().min(1),
});

const expandSubtreeSchema = z.object({
  rootNode: subtreeNodeSchema,
  nodes: z.array(subtreeNodeSchema).optional().default([]),
  edges: z.array(subtreeEdgeSchema).optional().default([]),
  question: z.string().optional(),
});

router.post('/runs/:runId/expand-subtree', async (req: Request, res: Response) => {
  if (!isOpenAIConfigured()) {
    return res.status(503).json({ error: 'OpenAI API key not configured. POST /ai/key first.' });
  }

  try {
    const runId = String(req.params.runId);
    const body = expandSubtreeSchema.parse(req.body);

    const allNodes = [body.rootNode, ...body.nodes.filter(n => n.id !== body.rootNode.id)];

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'ExpansionAgent',
        eventType: 'expansion.started',
        message: `Expanding branch "${body.rootNode.label}" — generating search queries…`,
        payload: {
          rootNode: body.rootNode.label,
          subtreeSize: allNodes.length,
          question: body.question ?? null,
        },
      },
    });

    const result = await expandSubtree({
      rootNode: body.rootNode,
      nodes: allNodes,
      edges: body.edges,
      question: body.question,
    });

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'ExpansionAgent',
        eventType: 'expansion.searched',
        message: `Web search complete: ${result.searchResultCount} result(s) from ${result.searchQueries.length} quer(y/ies)`,
        payload: { queries: result.searchQueries, resultCount: result.searchResultCount },
      },
    });

    // Persist all new triples and stream each one via SSE
    let persisted = 0;
    if (result.newTriples.length > 0) {
      const normalized = normalizeExtractedTriples('ExpansionAgent', result.newTriples);
      for (const triple of normalized) {
        await persistTriple(runId, triple);
        persisted++;
      }
    }

    broadcast({
      event: 'agent.step',
      data: {
        runId,
        agentName: 'ExpansionAgent',
        eventType: 'expansion.completed',
        message: `Branch "${body.rootNode.label}" expanded: ${persisted} new relationship(s) added to graph`,
        payload: {
          rootNode: body.rootNode.label,
          newTriples: persisted,
          searchQueries: result.searchQueries,
          summary: result.summary,
        },
      },
    });

    return res.json({
      ok: true,
      summary: result.summary,
      newTriplesPersisted: persisted,
      searchQueries: result.searchQueries,
      searchResultCount: result.searchResultCount,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in expand-subtree endpoint:', message);
    return res.status(500).json({ error: message });
  }
});

export default router;
