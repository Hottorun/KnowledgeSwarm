interface WorkerNode {
  id: string;
  position: { x: number; y: number };
  data: { nodeType: string; label: string; description?: string };
}

interface WorkerEdge {
  source: string;
  target: string;
}

// Inlined from GraphNode.tsx so the worker has no React/DOM deps
const nodeDims: Record<string, { w: number; h: number }> = {
  root:     { w: 210, h: 76 },
  topic:    { w: 175, h: 62 },
  subtopic: { w: 130, h: 46 },
  detail:   { w: 110, h: 40 },
};
const charWidths: Record<string, number> = { root: 8, topic: 7, subtopic: 6.5, detail: 6 };
const LABEL_WRAP_AT = 25;
const BADGE_WALL_CLEARANCE = 12;
const baseProps: Record<string, { px: number; py: number }> = {
  root:     { px: 22, py: 18 },
  topic:    { px: 18, py: 14 },
  subtopic: { px: 12, py: 10 },
  detail:   { px: 12, py:  8 },
};

function calcNodeDims(nodeType: string, label: string, description: string | undefined, hasAccent: boolean) {
  const base = nodeDims[nodeType] ?? nodeDims.detail;
  const bp = baseProps[nodeType] ?? baseProps.detail;
  const charW = charWidths[nodeType] ?? 6;
  const lineH = nodeType === 'root' ? 24 : nodeType === 'topic' ? 20 : 18;
  const labelLines = Math.ceil(label.length / LABEL_WRAP_AT);
  const effectiveLineChars = Math.min(label.length, LABEL_WRAP_AT);
  const badgeW = hasAccent && description ? description.length * 6 + 12 : 0;
  const innerW = 16 + effectiveLineChars * charW + (badgeW > 0 ? 8 + badgeW : 0);
  const rightPad = bp.px + (badgeW > 0 ? BADGE_WALL_CLEARANCE : 0);
  const w = Math.max(base.w, Math.ceil(innerW + bp.px + rightPad));
  let h = Math.max(base.h, bp.py * 2 + labelLines * lineH);
  if (description && !hasAccent) {
    const availW = w - 2 * bp.px - 16;
    const charsPerLine = Math.max(Math.floor(availW / 5.5), 1);
    const extraLines = Math.max(0, Math.ceil(description.length / charsPerLine) - 1);
    h += extraLines * 18;
  }
  return { w, h };
}

function getNodeDims(n: WorkerNode) {
  return calcNodeDims(n.data.nodeType, n.data.label, n.data.description, true);
}

const REPULSION = 28000;
const IDEAL_LENGTH = 320;
const STIFFNESS = 0.07;
const DAMPING = 0.80;
const ITERATIONS = 450;
const NODE_GAP = 20;

function forceDirectedLayout(
  layoutNodes: WorkerNode[],
  layoutEdges: WorkerEdge[],
  manualPins: Set<string>,
): WorkerNode[] {
  if (layoutNodes.length === 0) return layoutNodes;

  const pos = new Map(layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]));
  const vel = new Map(layoutNodes.map(n => [n.id, { x: 0, y: 0 }]));
  const pinned = new Set(
    layoutNodes.filter(n => n.data.nodeType === 'root' || manualPins.has(n.id)).map(n => n.id),
  );

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = new Map(layoutNodes.map(n => [n.id, { x: 0, y: 0 }]));

    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i]; const b = layoutNodes[j];
        const pa = pos.get(a.id)!; const pb = pos.get(b.id)!;
        let dx = pb.x - pa.x; let dy = pb.y - pa.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          const angle = (i + j * 1.618) * 2.399;
          dx = Math.cos(angle) * 0.1; dy = Math.sin(angle) * 0.1;
        }
        const d = Math.sqrt(d2 || 0.01);
        const f = REPULSION / (d * d);
        const fx = (dx / d) * f; const fy = (dy / d) * f;
        forces.get(a.id)!.x -= fx; forces.get(a.id)!.y -= fy;
        forces.get(b.id)!.x += fx; forces.get(b.id)!.y += fy;
      }
    }

    for (const edge of layoutEdges) {
      const pa = pos.get(edge.source); const pb = pos.get(edge.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x; const dy = pb.y - pa.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const stretch = d - IDEAL_LENGTH;
      const f = STIFFNESS * stretch;
      const fx = (dx / d) * f; const fy = (dy / d) * f;
      forces.get(edge.source)!.x += fx; forces.get(edge.source)!.y += fy;
      forces.get(edge.target)!.x -= fx; forces.get(edge.target)!.y -= fy;
    }

    for (const n of layoutNodes) {
      if (pinned.has(n.id)) continue;
      const v = vel.get(n.id)!; const f = forces.get(n.id)!;
      v.x = (v.x + f.x) * DAMPING; v.y = (v.y + f.y) * DAMPING;
      const p = pos.get(n.id)!;
      p.x += v.x; p.y += v.y;
    }
  }

  return layoutNodes.map(n => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

function resolveOverlaps(layoutNodes: WorkerNode[], manualPins: Set<string>): WorkerNode[] {
  if (layoutNodes.length < 2) return layoutNodes;

  const pos = new Map(layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]));
  const dims = new Map(layoutNodes.map(n => [n.id, getNodeDims(n)]));
  const pinned = new Set(
    layoutNodes.filter(n => n.data.nodeType === 'root' || manualPins.has(n.id)).map(n => n.id),
  );
  const OVERSHOOT = 1.05;

  for (let iter = 0; iter < 2000; iter++) {
    let anyOverlap = false;
    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i]; const b = layoutNodes[j];
        const pa = pos.get(a.id)!; const pb = pos.get(b.id)!;
        const da = dims.get(a.id)!; const db = dims.get(b.id)!;
        const overlapX = Math.min(pa.x + da.w + NODE_GAP, pb.x + db.w + NODE_GAP) - Math.max(pa.x - NODE_GAP, pb.x - NODE_GAP);
        const overlapY = Math.min(pa.y + da.h + NODE_GAP, pb.y + db.h + NODE_GAP) - Math.max(pa.y - NODE_GAP, pb.y - NODE_GAP);
        if (overlapX <= 0 || overlapY <= 0) continue;
        anyOverlap = true;
        const aPinned = pinned.has(a.id); const bPinned = pinned.has(b.id);
        const aCenterX = pa.x + da.w / 2; const bCenterX = pb.x + db.w / 2;
        const aCenterY = pa.y + da.h / 2; const bCenterY = pb.y + db.h / 2;
        if (overlapX <= overlapY) {
          const dir = bCenterX >= aCenterX ? 1 : -1;
          const push = overlapX * OVERSHOOT; const half = push / 2;
          if (!aPinned && !bPinned) { pa.x -= dir * half; pb.x += dir * half; }
          else if (aPinned) { pb.x += dir * push; }
          else { pa.x -= dir * push; }
        } else {
          const dir = bCenterY >= aCenterY ? 1 : -1;
          const push = overlapY * OVERSHOOT; const half = push / 2;
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

self.onmessage = (e: MessageEvent) => {
  const { id, nodes, edges, manualPins } = e.data as {
    id: number;
    nodes: WorkerNode[];
    edges: WorkerEdge[];
    manualPins: string[];
  };
  const laidOut = resolveOverlaps(
    forceDirectedLayout(nodes, edges, new Set(manualPins)),
    new Set(manualPins),
  );
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of laidOut) positions[n.id] = n.position;
  self.postMessage({ id, positions });
};
