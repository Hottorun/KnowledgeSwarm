import type { GraphNode, Triple } from '../types';
import { emitAgentEvent } from '../tools/emit';

export interface MainEntityDetection {
  entity: GraphNode;
  confidence: number;
  source: 'extracted' | 'document-fallback';
  reason: string;
}

// Heuristic main-entity selection. Documents and category nodes are scaffold
// structure and never qualify. Companies and organizations get the strongest
// type bias; high-confidence triples and subject roles outrank object roles.
export function pickMainEntityFromTriples(triples: Triple[]): MainEntityDetection | null {
  if (triples.length === 0) return null;

  const scores = new Map<string, { node: GraphNode; score: number; subjectCount: number; mentions: number }>();
  for (const triple of triples) {
    for (const [node, roleWeight] of [[triple.subject, 1.25], [triple.object, 1]] as const) {
      const type = node.type.toLowerCase();
      if (type === 'document' || type === 'category') continue;
      const typeScore = type.includes('company')
        ? 6
        : type.includes('organization')
        ? 5
        : type.includes('entity')
        ? 2
        : 1;
      const edgeScore = (triple.confidence ?? 0.75) * typeScore * roleWeight;
      const current = scores.get(node.id) ?? { node, score: 0, subjectCount: 0, mentions: 0 };
      current.score += edgeScore;
      current.mentions++;
      if (node.id === triple.subject.id) current.subjectCount++;
      scores.set(node.id, current);
    }
  }

  const ranked = [...scores.values()].sort((a, b) =>
    b.score - a.score || b.subjectCount - a.subjectCount || b.mentions - a.mentions
  );
  if (ranked.length === 0) return null;

  const winner = ranked[0];
  const runner = ranked[1];
  // Confidence is a normalized lead over the runner-up (or 0.6 if no runner).
  const lead = runner ? winner.score / Math.max(runner.score, 0.001) : 3;
  const confidence = Math.max(0.55, Math.min(0.97, 0.55 + Math.log2(lead) * 0.18));

  return {
    entity: winner.node,
    confidence: Number(confidence.toFixed(2)),
    source: 'extracted',
    reason: runner
      ? `Top-scoring ${winner.node.type} after ${ranked.length} candidates (lead ${lead.toFixed(2)}× over ${runner.node.label}).`
      : `Only viable ${winner.node.type} candidate among extracted entities.`,
  };
}

// When no extracted entity qualifies, synthesize one from the document name so
// the graph still has a center. The frontend's chooseInitialCenter will pick
// it via presentationRole: 'main_entity'.
export function fallbackMainEntityFromDocument(documentName: string): MainEntityDetection {
  const cleaned = documentName.replace(/^local:\/\//, '').replace(/\.[^/.]+$/, '').trim();
  const label = cleaned || 'Source Document';
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source';
  return {
    entity: {
      id: `entity:${slug}`,
      label,
      type: 'Entity',
      properties: { presentationRole: 'main_entity', synthetic: true, derivedFrom: 'documentName' },
    },
    confidence: 0.55,
    source: 'document-fallback',
    reason: `No company/organization extracted; using document name "${label}" as the graph anchor.`,
  };
}

export async function detectMainEntity(
  runId: string,
  triples: Triple[],
  documentName: string,
): Promise<MainEntityDetection> {
  await emitAgentEvent(runId, 'MainEntityAgent', 'main_entity.start', 'Selecting the central entity for this graph');

  const detection = pickMainEntityFromTriples(triples) ?? fallbackMainEntityFromDocument(documentName);

  await emitAgentEvent(
    runId,
    'MainEntityAgent',
    detection.source === 'extracted' ? 'main_entity.selected' : 'main_entity.fallback',
    `${detection.entity.label} (${detection.entity.type}) — ${detection.reason}`,
    {
      id: detection.entity.id,
      label: detection.entity.label,
      type: detection.entity.type,
      confidence: detection.confidence,
      source: detection.source,
    },
  );

  return detection;
}
