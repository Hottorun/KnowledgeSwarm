import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { persistTriple } from '../services/graph';
import { chunkText, normalizeExtractedTriples, RawExtractedTriple } from '../services/ingestion';
import { runSwarmExtraction } from '../services/swarm';
import { broadcast } from '../sse';
import {
  expandSubtree,
  extractTriplesFromChunk,
  describeNode,
  isOpenAIConfigured,
  setRuntimeOpenAIKey,
  validateKeyFormat,
  verifyOpenAIKey,
} from '../services/ai';

const router = Router();

const extractSchema = z.object({
  text: z.string().min(1),
  documentName: z.string().optional().default('input'),
});

const keySchema = z.object({
  apiKey: z.string().min(1),
  verify: z.boolean().optional(),
});

const expandSchema = z.object({
  rootNode: z.object({
    id: z.string(),
    label: z.string(),
    type: z.string().optional(),
  }),
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.string().optional(),
  })).optional().default([]),
  edges: z.array(z.object({
    subjectLabel: z.string(),
    predicate: z.string(),
    objectLabel: z.string(),
  })).optional().default([]),
  question: z.string().optional(),
  parentNode: z.object({
    id: z.string(),
    label: z.string(),
    type: z.string().optional(),
  }).optional(),
  siblings: z.array(z.string()).optional().default([]),
  graphDepth: z.number().optional().default(0),
  globalBranches: z.array(z.string()).optional().default([]),
});

router.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: isOpenAIConfigured(), mode: isOpenAIConfigured() ? 'openai' : 'heuristic-fallback' });
});

router.post('/key', async (req: Request, res: Response) => {
  try {
    const { apiKey, verify } = keySchema.parse(req.body);
    if (!validateKeyFormat(apiKey)) {
      return res.status(400).json({ error: 'Invalid OpenAI API key format' });
    }
    if (verify) {
      const ok = await verifyOpenAIKey(apiKey);
      if (!ok) return res.status(400).json({ error: 'OpenAI API key verification failed' });
    }
    setRuntimeOpenAIKey(apiKey);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    return res.status(500).json({ error: 'Failed to save key' });
  }
});

router.post('/runs/:runId/extract', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { text, documentName } = extractSchema.parse(req.body);

    await emit(runId, 'ExtractionAgent', 'extracting', `Extracting graph triples from ${documentName}`);
    const chunks = chunkText(text, 500, 50);
    let rawTriples: RawExtractedTriple[];

    if (isOpenAIConfigured()) {
      const results = await Promise.all(chunks.map(chunk => extractTriplesFromChunk(chunk.text, chunk.index, documentName)));
      rawTriples = results.flatMap(result => result.triples);
      const errors = results.filter(result => result.error);
      if (errors.length > 0) {
        await emit(runId, 'ExtractionAgent', 'warning', `${errors.length} chunk(s) failed AI extraction; using extracted triples from remaining chunks`);
      }
      if (rawTriples.length === 0) {
        rawTriples = extractHeuristicTriples(text, documentName);
      }
    } else {
      rawTriples = extractHeuristicTriples(text, documentName);
    }

    const triples = normalizeExtractedTriples('ExtractionAgent', rawTriples);

    for (const triple of triples) {
      await persistTriple(runId, triple);
    }

    await emit(runId, 'ExtractionAgent', 'completed', `Persisted ${triples.length} triples from ${documentName}`);
    return res.json({ ok: true, extracted: rawTriples.length, persisted: triples.length });
  } catch (err) {
    return handleRouteError(res, err, 'Extraction failed');
  }
});

router.post('/runs/:runId/swarm-extract', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { text, documentName } = extractSchema.parse(req.body);

    await emit(runId, 'SwarmOrchestrator', 'started', `Starting specialist swarm for ${documentName}`);
    const result = await runSwarmExtraction(runId, text, documentName);

    if (!result.ok) {
      console.error('[swarm] failed:', result.stderr || result.stdout);
      await emit(runId, 'SwarmOrchestrator', 'failed', `Specialist swarm failed with code ${result.code ?? 'unknown'}`);
      return res.status(502).json({
        error: 'Specialist swarm failed',
        code: result.code,
        details: (result.stderr || result.stdout).slice(-2000),
      });
    }

    await emit(runId, 'SwarmOrchestrator', 'completed', `Specialist swarm completed for ${documentName}`);
    return res.json({ ok: true, mode: 'swarm', stdout: result.stdout.slice(-2000) });
  } catch (err) {
    return handleRouteError(res, err, 'Swarm extraction failed');
  }
});

router.post('/runs/:runId/expand-subtree', async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);
    const { rootNode, nodes, edges, question, parentNode, siblings, graphDepth, globalBranches } = expandSchema.parse(req.body);
    const rawTriples: RawExtractedTriple[] = [];

    let summary: string;

    if (isOpenAIConfigured()) {
      const result = await expandSubtree({
        rootNode: { id: rootNode.id, label: rootNode.label, type: rootNode.type || 'Entity' },
        nodes: nodes.map(node => ({ id: node.id, label: node.label, type: node.type || 'Entity' })),
        edges,
        question,
        parentNode: parentNode ? { id: parentNode.id, label: parentNode.label, type: parentNode.type || 'Entity' } : undefined,
        siblings,
        graphDepth,
        globalBranches,
      });
      rawTriples.push(...result.newTriples);
      summary = result.summary;
    } else {
      const relatedNodes = nodes.filter(node => node.id !== rootNode.id).slice(0, 4);

      for (const edge of edges.slice(0, 8)) {
        rawTriples.push({
          subject: edge.subjectLabel,
          predicate: edge.predicate || 'connected_to',
          object: edge.objectLabel,
          confidence: 0.7,
          source: {
            documentName: 'current-graph',
            snippet: `${edge.subjectLabel} ${edge.predicate} ${edge.objectLabel}`,
          },
        });
      }

      for (const node of relatedNodes) {
        rawTriples.push({
          subject: rootNode.label,
          predicate: question?.toLowerCase().includes('risk') ? 'has_context' : 'connected_to',
          object: node.label,
          subjectType: rootNode.type || 'Entity',
          objectType: node.type || 'Entity',
          confidence: 0.65,
          source: {
            documentName: 'graph-expansion',
            snippet: question || `Expanded from ${rootNode.label}`,
          },
        });
      }

      summary = `Expanded ${rootNode.label} using ${nodes.length} visible nodes and ${edges.length} visible relationships.`;
    }

    const triples = normalizeExtractedTriples('ExpansionAgent', rawTriples);
    for (const triple of triples) {
      await persistTriple(runId, triple);
    }

    await emit(runId, 'ExpansionAgent', 'completed', summary);
    return res.json({ summary, newTriplesPersisted: triples.length });
  } catch (err) {
    return handleRouteError(res, err, 'Expansion failed');
  }
});

const describeNodeSchema = z.object({
  label: z.string().min(1),
  entityType: z.string().optional().default('Entity'),
  relationships: z.array(z.object({
    direction: z.enum(['out', 'in']),
    predicate: z.string(),
    otherLabel: z.string(),
  })).optional().default([]),
});

router.post('/describe-node', async (req: Request, res: Response) => {
  try {
    const { label, entityType, relationships } = describeNodeSchema.parse(req.body);
    if (!isOpenAIConfigured()) {
      return res.json({ description: null });
    }
    const description = await describeNode(label, entityType, relationships);
    return res.json({ description });
  } catch (err) {
    return handleRouteError(res, err, 'Description failed');
  }
});

function extractHeuristicTriples(text: string, documentName: string): RawExtractedTriple[] {
  const sentences = text.split(/[.!?\n]+/).map(sentence => sentence.trim()).filter(Boolean);
  const triples: RawExtractedTriple[] = [];

  for (const sentence of sentences) {
    addMatch(triples, sentence, /(.+?)\s+acquired\s+(.+)/i, 'acquired', documentName);
    addMatch(triples, sentence, /(.+?)\s+signed\s+(?:a\s+)?(?:supply\s+)?agreement\s+with\s+(.+)/i, 'signed_agreement_with', documentName);
    addMatch(triples, sentence, /(.+?)\s+is\s+led\s+by\s+(.+)/i, 'led_by', documentName);
    addMatch(triples, sentence, /(.+?)\s+develops\s+(.+)/i, 'develops', documentName);
    addMatch(triples, sentence, /(.+?)\s+manufactures\s+(.+)/i, 'manufactures', documentName);
    addMatch(triples, sentence, /(.+?)\s+depends\s+on\s+(.+)/i, 'depends_on', documentName);
    addMatch(triples, sentence, /(.+?)\s+faces\s+(.+)/i, 'faces', documentName);
    addMatch(triples, sentence, /(.+?)\s+has\s+(.+)/i, 'has', documentName);
    addMatch(triples, sentence, /(.+?)\s+will\s+provide\s+(.+)/i, 'provides', documentName);
  }

  if (triples.length === 0) {
    const title = documentName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    triples.push({
      subject: title,
      predicate: 'contains',
      object: text.slice(0, 80),
      subjectType: 'Document',
      objectType: 'Entity',
      confidence: 0.5,
      source: { documentName, snippet: text.slice(0, 200) },
    });
  }

  return triples;
}

function addMatch(
  triples: RawExtractedTriple[],
  sentence: string,
  pattern: RegExp,
  predicate: string,
  documentName: string,
) {
  const match = sentence.match(pattern);
  if (!match) return;

  const subject = cleanEntity(match[1]);
  const object = cleanEntity(match[2]);
  if (!subject || !object || subject.length > 120 || object.length > 160) return;

  triples.push({
    subject,
    predicate,
    object,
    confidence: 0.82,
    source: { documentName, snippet: sentence },
  });
}

function cleanEntity(value: string): string {
  return value
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function emit(runId: string, agentName: string, eventType: string, message: string) {
  broadcast({ event: 'agent.step', data: { runId, agentName, eventType, message, payload: {} } });
}

function handleRouteError(res: Response, err: unknown, fallback: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid input', details: err.errors });
  }
  const message = err instanceof Error ? err.message : fallback;
  return res.status(500).json({ error: message });
}

export default router;
