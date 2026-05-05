import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';

function normalizeId(id: string): string {
  return id.trim().replace(/\s+/g, '-').replace(/[^\w:.-]/g, '');
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

export function cleanGraph(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // ── 1. VALIDATION ──────────────────────────────────────────────────────────
  // Keep only nodes with id + label
  const validRaw = rawNodes.filter(n => {
    const data = n.data as GraphNodeData;
    return n.id && typeof n.id === 'string' && n.id.trim().length > 0
      && data.label && typeof data.label === 'string' && data.label.trim().length > 0;
  });

  // ── 2. NORMALIZATION ───────────────────────────────────────────────────────
  const idRemap = new Map<string, string>();
  const normalized: GraphNode[] = validRaw.map(n => {
    const data = n.data as GraphNodeData;
    const newId = normalizeId(n.id);
    if (newId !== n.id) idRemap.set(n.id, newId);
    return {
      ...n,
      id: newId,
      data: { ...data, label: normalizeLabel(data.label) },
    };
  });

  // ── 3. DEDUPLICATION ───────────────────────────────────────────────────────
  // Merge nodes whose labels are identical (case-insensitive), except Documents
  // (documents are always unique — same title can be different files).
  const seenLabel = new Map<string, string>(); // labelKey → canonical id
  const mergeMap = new Map<string, string>();   // duplicate id → canonical id
  const deduped: GraphNode[] = [];

  for (const node of normalized) {
    const data = node.data as GraphNodeData;
    const isDocument = String(data.description ?? '').toLowerCase() === 'document';
    const key = isDocument ? `__doc__${node.id}` : data.label.toLowerCase();

    if (seenLabel.has(key)) {
      const canonicalId = seenLabel.get(key)!;
      mergeMap.set(node.id, canonicalId);
      // Merge properties into canonical node (canonical label/type wins)
      const idx = deduped.findIndex(n => n.id === canonicalId);
      if (idx >= 0) {
        const canonical = deduped[idx];
        deduped[idx] = {
          ...canonical,
          data: {
            ...node.data,
            ...(canonical.data as GraphNodeData),
            label: (canonical.data as GraphNodeData).label,
          },
        };
      }
    } else {
      seenLabel.set(key, node.id);
      deduped.push(node);
    }
  }

  const validIds = new Set(deduped.map(n => n.id));

  function remapId(id: string): string {
    const a = idRemap.get(id) ?? id;
    return mergeMap.get(a) ?? a;
  }

  // ── 4. EDGE CLEANUP ────────────────────────────────────────────────────────
  const seenEdges = new Set<string>();
  const cleanEdges: GraphEdge[] = [];

  for (const edge of rawEdges) {
    const src = remapId(edge.source);
    const tgt = remapId(edge.target);

    if (!validIds.has(src) || !validIds.has(tgt)) continue; // invalid endpoint
    if (src === tgt) continue;                               // self-loop

    const edgeKey = `${src}|${String(edge.label ?? '')}|${tgt}`;
    if (seenEdges.has(edgeKey)) continue;                   // duplicate
    seenEdges.add(edgeKey);

    // Clamp weight/confidence to [0, 1]
    const edgeData = edge.data as Record<string, unknown> | undefined;
    const rawConf = typeof edgeData?.confidence === 'number' ? edgeData.confidence : undefined;
    const conf = rawConf !== undefined ? Math.max(0, Math.min(1, rawConf)) : rawConf;
    const newData =
      conf !== rawConf && edgeData ? { ...edgeData, confidence: conf } : edge.data;

    cleanEdges.push({
      ...edge,
      id: `${src}:${String(edge.label ?? 'related')}:${tgt}`,
      source: src,
      target: tgt,
      data: newData,
    });
  }

  // ── 5. SCALE SAFETY ────────────────────────────────────────────────────────
  let finalNodes = deduped;
  let finalEdges = cleanEdges;

  if (deduped.length > 10_000) {
    const degree = new Map<string, number>();
    for (const e of cleanEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const maxDeg = Math.max(...degree.values(), 1);

    finalNodes = deduped.filter(n => {
      const data = n.data as GraphNodeData;
      if (data.nodeType === 'root' || data.nodeType === 'topic') return true;
      return (degree.get(n.id) ?? 0) / maxDeg >= 0.2;
    });

    const keptIds = new Set(finalNodes.map(n => n.id));
    finalEdges = cleanEdges.filter(e => keptIds.has(e.source) && keptIds.has(e.target));
  }

  return { nodes: finalNodes, edges: finalEdges };
}
