import { getSupabase } from '../supabase';
import { broadcast } from '../sse';

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  predicate: string;
  confidence?: number;
  sources?: Source[];
  properties: Record<string, unknown>;
}

export interface Source {
  url: string;
  title?: string;
  snippet?: string;
}

export interface Triple {
  agentName?: string;
  subject: GraphNode;
  predicate: string;
  object: GraphNode;
  confidence?: number;
  sources?: Source[];
  properties?: Record<string, unknown>;
}

export interface LoadedRunGraph {
  runId: string;
  status?: string;
  prompt?: string | null;
  nodes: GraphNode[];
  edges: Array<GraphEdge & { id: string }>;
  sources: Array<Source & { id: string; edgeId?: string }>;
}

// Read everything persisted for a run so the frontend can rehydrate without
// replaying the SSE history. Sources are joined back to their edges via the
// edge_sources table so the caller gets a self-contained graph snapshot.
export async function loadRunGraph(runId: string): Promise<LoadedRunGraph | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const [{ data: run, error: runError }, { data: nodeRows, error: nodeError }, { data: edgeRows, error: edgeError }] = await Promise.all([
    supabase.from('research_runs').select('id, status, prompt').eq('id', runId).maybeSingle(),
    supabase.from('graph_nodes').select('id, label, type, properties').eq('run_id', runId),
    supabase.from('graph_edges').select('id, source_node_id, target_node_id, predicate, confidence, properties').eq('run_id', runId),
  ]);
  if (runError) throw new Error(`Supabase select failed for research_runs: ${runError.message}`);
  if (nodeError) throw new Error(`Supabase select failed for graph_nodes: ${nodeError.message}`);
  if (edgeError) throw new Error(`Supabase select failed for graph_edges: ${edgeError.message}`);
  if (!run) return null;

  const edgeIds = (edgeRows ?? []).map(row => row.id).filter((id): id is string => Boolean(id));
  let edgeSourceLinks: Array<{ edge_id: string; source_id: string }> = [];
  let sourceRows: Array<{ id: string; url: string; title: string | null; snippet: string | null }> = [];
  if (edgeIds.length > 0) {
    const { data: linkRows, error: linkError } = await supabase
      .from('edge_sources')
      .select('edge_id, source_id')
      .in('edge_id', edgeIds);
    if (linkError) throw new Error(`Supabase select failed for edge_sources: ${linkError.message}`);
    edgeSourceLinks = linkRows ?? [];
    const sourceIds = [...new Set(edgeSourceLinks.map(link => link.source_id))];
    if (sourceIds.length > 0) {
      const { data: rows, error: sourceError } = await supabase
        .from('sources')
        .select('id, url, title, snippet')
        .in('id', sourceIds);
      if (sourceError) throw new Error(`Supabase select failed for sources: ${sourceError.message}`);
      sourceRows = rows ?? [];
    }
  }

  const sourcesById = new Map(sourceRows.map(row => [row.id, row]));
  const sourcesForEdge = new Map<string, Source[]>();
  for (const link of edgeSourceLinks) {
    const source = sourcesById.get(link.source_id);
    if (!source) continue;
    const list = sourcesForEdge.get(link.edge_id) ?? [];
    list.push({ url: source.url, title: source.title ?? undefined, snippet: source.snippet ?? undefined });
    sourcesForEdge.set(link.edge_id, list);
  }

  return {
    runId,
    status: run.status ?? undefined,
    prompt: run.prompt ?? null,
    nodes: (nodeRows ?? []).map(row => ({
      id: row.id,
      label: row.label,
      type: row.type,
      properties: (row.properties ?? {}) as Record<string, unknown>,
    })),
    edges: (edgeRows ?? []).map(row => ({
      id: row.id,
      source: row.source_node_id,
      target: row.target_node_id,
      predicate: row.predicate,
      confidence: row.confidence ?? undefined,
      properties: (row.properties ?? {}) as Record<string, unknown>,
      sources: sourcesForEdge.get(row.id) ?? [],
    })),
    sources: edgeSourceLinks.flatMap(link => {
      const source = sourcesById.get(link.source_id);
      return source ? [{
        id: source.id,
        edgeId: link.edge_id,
        url: source.url,
        title: source.title ?? undefined,
        snippet: source.snippet ?? undefined,
      }] : [];
    }),
  };
}

export async function persistTriple(runId: string, triple: Triple): Promise<void> {
  const supabase = getSupabase();
  const agentName = triple.agentName || null;
  const edgeProperties = {
    ...(triple.properties || {}),
    ...(agentName ? { agentName } : {}),
  };
  let subjectForBroadcast = triple.subject;
  let objectForBroadcast = triple.object;

  if (supabase) {
    const [subjectProperties, objectProperties] = await Promise.all([
      mergedNodeProperties(runId, triple.subject.id, triple.subject.properties),
      mergedNodeProperties(runId, triple.object.id, triple.object.properties),
    ]);
    subjectForBroadcast = { ...triple.subject, properties: subjectProperties };
    objectForBroadcast = { ...triple.object, properties: objectProperties };

    const { error: subjectError } = await supabase.from('graph_nodes').upsert(
      {
        run_id: runId,
        id: triple.subject.id,
        label: triple.subject.label,
        type: triple.subject.type,
        properties: subjectProperties,
        created_by_agent: agentName,
      },
      { onConflict: 'run_id,id' }
    );
    if (subjectError) throw new Error(`Supabase upsert failed for node "${triple.subject.id}": ${subjectError.message}`);

    const { error: objectError } = await supabase.from('graph_nodes').upsert(
      {
        run_id: runId,
        id: triple.object.id,
        label: triple.object.label,
        type: triple.object.type,
        properties: objectProperties,
        created_by_agent: agentName,
      },
      { onConflict: 'run_id,id' }
    );
    if (objectError) throw new Error(`Supabase upsert failed for node "${triple.object.id}": ${objectError.message}`);

    const { data: edge, error: edgeError } = await supabase.from('graph_edges').insert({
      run_id: runId,
      source_node_id: triple.subject.id,
      target_node_id: triple.object.id,
      predicate: triple.predicate,
      confidence: triple.confidence || null,
      properties: edgeProperties,
      created_by_agent: agentName,
    }).select('id').single();
    if (edgeError) throw new Error(`Supabase insert failed for edge "${triple.subject.id}" -> "${triple.object.id}": ${edgeError.message}`);

    if (triple.sources) {
      for (const source of triple.sources) {
        const { data: sourceRow, error: sourceError } = await supabase.from('sources').insert({
          run_id: runId,
          url: source.url,
          title: source.title || null,
          snippet: source.snippet || null,
          metadata: {},
        }).select('id').single();
        if (sourceError) throw new Error(`Supabase insert failed for source "${source.url}": ${sourceError.message}`);

        if (edge?.id && sourceRow?.id) {
          const { error: linkError } = await supabase.from('edge_sources').insert({
            edge_id: edge.id,
            source_id: sourceRow.id,
          });
          if (linkError) throw new Error(`Supabase insert failed for edge_sources link: ${linkError.message}`);
        }
      }
    }
  }

  broadcast({ event: 'node.created', data: { runId, node: subjectForBroadcast } });
  broadcast({ event: 'node.created', data: { runId, node: objectForBroadcast } });
  broadcast({
    event: 'edge.created',
    data: {
      runId,
      edge: {
        source: triple.subject.id,
        target: triple.object.id,
        predicate: triple.predicate,
        confidence: triple.confidence,
        sources: triple.sources || [],
        properties: edgeProperties,
      },
    },
  });

  if (triple.sources) {
    for (const source of triple.sources) {
      broadcast({
        event: 'source.created',
        data: {
          runId,
          edge: {
            source: triple.subject.id,
            target: triple.object.id,
            predicate: triple.predicate,
          },
          source,
        },
      });
    }
  }
}

async function mergedNodeProperties(
  runId: string,
  nodeId: string,
  incoming: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  if (!supabase) return incoming;

  const { data, error } = await supabase
    .from('graph_nodes')
    .select('properties')
    .eq('run_id', runId)
    .eq('id', nodeId)
    .maybeSingle();
  if (error) throw new Error(`Supabase select failed for node "${nodeId}" properties: ${error.message}`);

  return {
    ...((data?.properties ?? {}) as Record<string, unknown>),
    ...(incoming ?? {}),
  };
}
