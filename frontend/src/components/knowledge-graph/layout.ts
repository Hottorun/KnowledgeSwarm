import { calcNodeDims, type GraphEdge, type GraphNode, type GraphNodeData } from './graphTypes';

export type GraphLayoutNode = GraphNode<GraphNodeData>;

export function layout(
  nodes: GraphLayoutNode[],
  edges: GraphEdge[],
  manualPins: Set<string> = new Set(),
): GraphLayoutNode[] {
  return resolveOverlaps(forceDirectedLayout(nodes, edges, manualPins), manualPins);
}

function forceDirectedLayout(
  layoutNodes: GraphLayoutNode[],
  layoutEdges: GraphEdge[],
  manualPins: Set<string> = new Set(),
): GraphLayoutNode[] {
  if (layoutNodes.length === 0) return layoutNodes;

  const REPULSION = 28000;
  const IDEAL_LENGTH = 320;
  const STIFFNESS = 0.07;
  const DAMPING = 0.80;
  const ITERATIONS = 450;

  const pos = new Map<string, { x: number; y: number }>(
    layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]),
  );
  const vel = new Map<string, { x: number; y: number }>(
    layoutNodes.map(n => [n.id, { x: 0, y: 0 }]),
  );
  const pinned = new Set(
    layoutNodes
      .filter(n => (n.data as GraphNodeData).nodeType === 'root' || manualPins.has(n.id))
      .map(n => n.id),
  );

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = new Map<string, { x: number; y: number }>(
      layoutNodes.map(n => [n.id, { x: 0, y: 0 }]),
    );

    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i];
        const b = layoutNodes[j];
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          const angle = (i + j * 1.618) * 2.399;
          dx = Math.cos(angle) * 0.1;
          dy = Math.sin(angle) * 0.1;
        }
        const d = Math.sqrt(d2 || 0.01);
        const f = REPULSION / (d * d);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        forces.get(a.id)!.x -= fx;
        forces.get(a.id)!.y -= fy;
        forces.get(b.id)!.x += fx;
        forces.get(b.id)!.y += fy;
      }
    }

    for (const edge of layoutEdges) {
      const pa = pos.get(edge.source);
      const pb = pos.get(edge.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const stretch = d - IDEAL_LENGTH;
      const f = STIFFNESS * stretch;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      forces.get(edge.source)!.x += fx;
      forces.get(edge.source)!.y += fy;
      forces.get(edge.target)!.x -= fx;
      forces.get(edge.target)!.y -= fy;
    }

    for (const n of layoutNodes) {
      if (pinned.has(n.id)) continue;
      const v = vel.get(n.id)!;
      const f = forces.get(n.id)!;
      v.x = (v.x + f.x) * DAMPING;
      v.y = (v.y + f.y) * DAMPING;
      const p = pos.get(n.id)!;
      p.x += v.x;
      p.y += v.y;
    }
  }

  return layoutNodes.map(n => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

const NODE_GAP = 20;

function getNodeDims(n: GraphLayoutNode): { w: number; h: number } {
  const d = n.data as GraphNodeData;
  return calcNodeDims(d.nodeType, d.label, d.description, true);
}

function resolveOverlaps(
  layoutNodes: GraphLayoutNode[],
  manualPins: Set<string> = new Set(),
): GraphLayoutNode[] {
  if (layoutNodes.length < 2) return layoutNodes;

  const pos = new Map(layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]));
  const dims = new Map(layoutNodes.map(n => [n.id, getNodeDims(n)]));
  const pinned = new Set(
    layoutNodes
      .filter(n => (n.data as GraphNodeData).nodeType === 'root' || manualPins.has(n.id))
      .map(n => n.id),
  );
  const OVERSHOOT = 1.05;

  for (let iter = 0; iter < 2000; iter++) {
    let anyOverlap = false;

    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i];
        const b = layoutNodes[j];
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        const da = dims.get(a.id)!;
        const db = dims.get(b.id)!;
        const overlapX = Math.min(pa.x + da.w + NODE_GAP, pb.x + db.w + NODE_GAP) - Math.max(pa.x - NODE_GAP, pb.x - NODE_GAP);
        const overlapY = Math.min(pa.y + da.h + NODE_GAP, pb.y + db.h + NODE_GAP) - Math.max(pa.y - NODE_GAP, pb.y - NODE_GAP);

        if (overlapX <= 0 || overlapY <= 0) continue;
        anyOverlap = true;

        const aPinned = pinned.has(a.id);
        const bPinned = pinned.has(b.id);
        const aCenterX = pa.x + da.w / 2;
        const aCenterY = pa.y + da.h / 2;
        const bCenterX = pb.x + db.w / 2;
        const bCenterY = pb.y + db.h / 2;

        if (overlapX <= overlapY) {
          const dir = bCenterX >= aCenterX ? 1 : -1;
          const push = overlapX * OVERSHOOT;
          const half = push / 2;
          if (!aPinned && !bPinned) { pa.x -= dir * half; pb.x += dir * half; }
          else if (aPinned) { pb.x += dir * push; }
          else { pa.x -= dir * push; }
        } else {
          const dir = bCenterY >= aCenterY ? 1 : -1;
          const push = overlapY * OVERSHOOT;
          const half = push / 2;
          if (!aPinned && !bPinned) { pa.y -= dir * half; pb.y += dir * half; }
          else if (aPinned) { pb.y += dir * push; }
          else { pa.y -= dir * push; }
        }
      }
    }

    if (!anyOverlap) break;
  }

  return layoutNodes.map(n => ({ ...n, position: pos.get(n.id) ?? n.position }));
}
