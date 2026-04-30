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

export async function persistTriple(runId: string, triple: Triple): Promise<void> {
  const supabase = getSupabase();

  if (supabase) {
    const agentName = triple.agentName || null;

    const { error: subjectError } = await supabase.from('graph_nodes').upsert(
      {
        run_id: runId,
        id: triple.subject.id,
        label: triple.subject.label,
        type: triple.subject.type,
        properties: triple.subject.properties,
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
        properties: triple.object.properties,
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
      properties: triple.properties || {},
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

  broadcast({ event: 'node.created', data: { runId, node: triple.subject } });
  broadcast({ event: 'node.created', data: { runId, node: triple.object } });
  broadcast({ event: 'edge.created', data: { runId, edge: { source: triple.subject.id, target: triple.object.id, predicate: triple.predicate, confidence: triple.confidence } } });

  if (triple.sources) {
    for (const source of triple.sources) {
      broadcast({ event: 'source.created', data: { runId, source } });
    }
  }
}
