import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getSupabase } from '../supabase';
import { broadcast } from '../sse';
import { setRunRootContext } from '../services/ai';
import { runSwarmExtraction } from '../services/swarm';
import { loadRunGraph } from '../services/graph';

const router = Router();

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
});

const createDocumentSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().optional(),
  rawText: z.string().min(1),
});

const generateMapSchema = z.object({
  prompt: z.string().min(1).max(500).optional(),
  documentIds: z.array(z.string().uuid()).optional(),
});

// POST /projects
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = createProjectSchema.parse(req.body);
    const supabase = getSupabase();

    if (supabase) {
      const { data, error } = await supabase
        .from('projects')
        .insert({ name })
        .select()
        .single();

      if (error) {
        console.error('Supabase error creating project:', error);
        return res.status(500).json({ error: 'Failed to create project' });
      }

      return res.json(data);
    }

    // Local mode without Supabase
    const id = crypto.randomUUID();
    return res.json({ id, name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error creating project:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /projects
router.get('/', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();

    if (!supabase) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('projects')
      .select(`
        id,
        name,
        created_at,
        updated_at,
        project_documents(count),
        project_maps(count)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error listing projects:', error);
      return res.status(500).json({ error: 'Failed to list projects' });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error('Error listing projects:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /projects/:projectId
router.get('/:projectId', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId);
    const supabase = getSupabase();

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const [{ data: project, error: projectError }, { data: documents, error: docsError }, { data: maps, error: mapsError }] = await Promise.all([
      supabase.from('projects').select('*').eq('id', projectId).maybeSingle(),
      supabase.from('project_documents').select('id, project_id, name, mime_type, char_count, created_at').eq('project_id', projectId).order('created_at', { ascending: true }),
      supabase.from('project_maps').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    ]);

    if (projectError) return res.status(500).json({ error: projectError.message });
    if (docsError) return res.status(500).json({ error: docsError.message });
    if (mapsError) return res.status(500).json({ error: mapsError.message });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    return res.json({ ...project, documents: documents ?? [], maps: maps ?? [] });
  } catch (err) {
    console.error('Error getting project:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /projects/:projectId/documents
router.post('/:projectId/documents', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId);
    const { name, mimeType, rawText } = createDocumentSchema.parse(req.body);
    const supabase = getSupabase();

    if (!supabase) {
      const id = crypto.randomUUID();
      return res.json({ id, project_id: projectId, name, mime_type: mimeType ?? null, char_count: rawText.length, created_at: new Date().toISOString() });
    }

    const { data, error } = await supabase
      .from('project_documents')
      .insert({ project_id: projectId, name, mime_type: mimeType ?? null, raw_text: rawText })
      .select('id, project_id, name, mime_type, char_count, created_at')
      .single();

    if (error) {
      console.error('Supabase error saving document:', error);
      return res.status(500).json({ error: 'Failed to save document' });
    }

    return res.json(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error saving document:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /projects/:projectId/documents/:docId
router.delete('/:projectId/documents/:docId', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId);
    const docId = String(req.params.docId);
    const supabase = getSupabase();

    if (!supabase) {
      return res.json({ ok: true });
    }

    const { error } = await supabase
      .from('project_documents')
      .delete()
      .eq('id', docId)
      .eq('project_id', projectId);

    if (error) {
      console.error('Supabase error deleting document:', error);
      return res.status(500).json({ error: 'Failed to delete document' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting document:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /projects/:projectId/maps
router.get('/:projectId/maps', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId);
    const supabase = getSupabase();

    if (!supabase) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from('project_maps')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error listing maps:', error);
      return res.status(500).json({ error: 'Failed to list maps' });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error('Error listing maps:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /projects/:projectId/maps
router.post('/:projectId/maps', async (req: Request, res: Response) => {
  try {
    const projectId = String(req.params.projectId);
    const { prompt, documentIds } = generateMapSchema.parse(req.body);
    const supabase = getSupabase();

    // Fetch documents
    let combinedText = '';
    let docNames: string[] = [];

    if (supabase) {
      let query = supabase
        .from('project_documents')
        .select('id, name, raw_text')
        .eq('project_id', projectId);

      if (documentIds && documentIds.length > 0) {
        query = query.in('id', documentIds);
      }

      const { data: docs, error: docsError } = await query;
      if (docsError) {
        return res.status(500).json({ error: 'Failed to fetch documents' });
      }
      if (!docs || docs.length === 0) {
        return res.status(400).json({ error: 'No documents found for this project' });
      }

      combinedText = docs.map(doc => `--- ${doc.name} ---\n${doc.raw_text}`).join('\n\n');
      docNames = docs.map(doc => doc.name);
    } else {
      return res.status(503).json({ error: 'Supabase required for map generation' });
    }

    // Cache check: return existing completed map for same project + prompt
    if (prompt !== undefined) {
      const { data: cached } = await supabase
        .from('project_maps')
        .select('id, run_id, map_data')
        .eq('project_id', projectId)
        .eq('prompt', prompt)
        .eq('status', 'completed')
        .not('map_data', 'is', null)
        .limit(1)
        .maybeSingle();

      if (cached?.map_data) {
        return res.json({ mapId: cached.id, runId: cached.run_id, cached: true, mapData: cached.map_data });
      }
    }

    const mapName = prompt ? prompt.slice(0, 60) : `Map from ${docNames.slice(0, 2).join(', ')}${docNames.length > 2 ? '…' : ''}`;
    const runTopic = prompt || mapName;

    // Create research run
    let runId: string;
    const { data: runData, error: runError } = await supabase
      .from('research_runs')
      .insert({ prompt: runTopic, status: 'running' })
      .select()
      .single();

    if (runError || !runData) {
      console.error('Supabase error creating run:', runError);
      return res.status(500).json({ error: 'Failed to create run' });
    }
    runId = runData.id;
    setRunRootContext(runId, runTopic);
    broadcast({ event: 'run.status', data: { runId, status: 'running', prompt: runTopic } });

    // Create project map record
    const { data: mapData, error: mapError } = await supabase
      .from('project_maps')
      .insert({ project_id: projectId, run_id: runId, name: mapName, prompt: prompt ?? null, status: 'running' })
      .select()
      .single();

    if (mapError || !mapData) {
      console.error('Supabase error creating project map:', mapError);
      return res.status(500).json({ error: 'Failed to create project map' });
    }

    const mapId = mapData.id;

    // Trigger swarm extraction asynchronously — don't await so the response returns immediately
    const documentName = docNames.length === 1 ? docNames[0] : `${docNames.length} documents`;
    runSwarmExtraction(runId, combinedText, documentName, prompt || undefined)
      .then(async result => {
        const finalStatus = result.ok ? 'completed' : 'failed';
        if (supabase) {
          let mapUpdate: Record<string, unknown> = { status: finalStatus, updated_at: new Date().toISOString() };
          if (result.ok) {
            const graph = await loadRunGraph(runId);
            if (graph) mapUpdate.map_data = graph;
          }
          await supabase.from('project_maps').update(mapUpdate).eq('id', mapId);
          await supabase.from('research_runs').update({ status: finalStatus, updated_at: new Date().toISOString() }).eq('id', runId);
        }
        if (!result.ok) {
          console.error('[project map] swarm failed for map', mapId, result.stderr?.slice(-500));
        }
      })
      .catch(err => {
        console.error('[project map] swarm error:', err);
      });

    return res.json({ mapId, runId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error('Error generating map:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
