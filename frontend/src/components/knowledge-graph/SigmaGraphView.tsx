import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { Check, Copy, FileText, Maximize2, Minus, Plus, X } from 'lucide-react';

import { isMainEntityNode } from './presentationGraph';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';

interface SigmaGraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodeId?: string | null;
  highlightedNodes?: Set<string>;
  viewMode?: 'focused' | 'overview';
  // While true, the active-centre halo gently breathes to signal that the
  // orchestrator is still running. Driven by `isProcessing` in the canvas.
  isStreaming?: boolean;
  onNodeClick?: (nodeId: string) => void;
  onFocusNodes?: (nodeIds: string[]) => void;
  onPaneClick?: () => void;
}

type PositionedNode = {
  id: string;
  x: number;
  y: number;
  depth: number;
  angle: number;
};

type SigmaNodeAttributes = {
  x: number;
  y: number;
  label: string;
  size: number;
  color: string;
  forceLabel: boolean;
  zIndex: number;
  labelSize?: number;
  labelColor?: { color: string };
  labelWeight?: 'normal' | 'bold';
};

type SigmaEdgeAttributes = {
  size: number;
  color: string;
  label?: string;
  forceLabel?: boolean;
};

type NodeTween = {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

type EdgeEvidence = {
  title: string;
  predicate: string;
  confidence?: number;
  agentName?: string;
  category?: string;
  importance?: number;
  provenance: string[];
  sourceLabel?: string;
  sources: Array<{
    label: string;
    url?: string;
    snippet?: string;
    isLinkable: boolean;
    documentNodeId?: string;
    kind: 'web' | 'document' | 'local' | 'unknown';
  }>;
};

type BucketSelection = {
  id: string;
  label: string;
  members: Array<{ id: string; label: string; kind: string }>;
};

type DetailMode = 'full' | 'balanced' | 'essential';

const OVERVIEW_EDGE_LIMIT = 2500;
// Cap on how many direct spokes the central node gets. Overflow neighbors stay
// in the graph but are routed through semantic bucket nodes so the center stays
// readable without hiding useful evidence.
const MAX_LEVEL_1_FANOUT = 12;
const SIGMA_BUCKET_PREFIX = 'sigma-bucket:';
const SIGMA_HALO_PREFIX = 'sigma-halo:';
// Disabled (was 1800ms). Sticky positions caused early-arriving entities to
// freeze at depth 1 before their category parent arrived, so they stayed in
// the wrong wedge after the scaffold finished streaming. The radial layout
// is cheap enough to re-run on every batch — let it.
const STICKY_NODE_AFTER_MS = Number.POSITIVE_INFINITY;

function overviewEdgeLimit(nodeCount: number): number {
  if (nodeCount > 1500) return 1600;
  if (nodeCount > 900) return 2000;
  return OVERVIEW_EDGE_LIMIT;
}

function sigmaLabelSettings(nodeCount: number, viewMode: 'focused' | 'overview'): { labelDensity: number; labelRenderedSizeThreshold: number } {
  if (viewMode === 'focused') return { labelDensity: 0.18, labelRenderedSizeThreshold: 8 };
  if (nodeCount > 1200) return { labelDensity: 0.05, labelRenderedSizeThreshold: 17 };
  if (nodeCount > 700) return { labelDensity: 0.07, labelRenderedSizeThreshold: 15 };
  if (nodeCount > 350) return { labelDensity: 0.10, labelRenderedSizeThreshold: 13 };
  if (nodeCount > 80) return { labelDensity: 0.16, labelRenderedSizeThreshold: 11 };
  return { labelDensity: 0.28, labelRenderedSizeThreshold: 8 };
}

const LABEL_MAX_CHARS = 24;
function nodeLabel(node: GraphNode): string {
  const raw = String((node.data as GraphNodeData).label ?? node.id);
  return raw.length > LABEL_MAX_CHARS ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…` : raw;
}

function nodeKind(node: GraphNode): string {
  return String((node.data as GraphNodeData).description ?? (node.data as GraphNodeData).nodeType ?? 'Entity');
}

function isExplicitCategoryNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  const role = String(data.presentationRole ?? '');
  const description = String(data.description ?? '').toLowerCase();
  return role === 'category' || role === 'business_area' || description === 'category';
}

function isSubcategoryNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  return data.presentationRole === 'subcategory' || String(data.description ?? '').toLowerCase() === 'subcategory';
}

function isScaffoldStructuralNode(node: GraphNode | undefined): boolean {
  return isExplicitCategoryNode(node) || isSubcategoryNode(node);
}

// Vibrant category accent colors — each category gets a distinct saturated hue
// so spatial regions of the graph are immediately identifiable.
const CATEGORY_ACCENT: Record<string, string> = {
  finance:           '#f59e0b', // amber-400
  'hr-people':       '#10b981', // emerald-500
  legal:             '#8b5cf6', // violet-500
  operations:        '#06b6d4', // cyan-500
  risk:              '#ef4444', // red-500
  technology:        '#3b82f6', // blue-500
  'strategy-market': '#f97316', // orange-500
  other:             '#6366f1', // indigo-500
};

function categoryAccent(node: GraphNode | undefined): string | null {
  if (!node) return null;
  const data = node.data as GraphNodeData;
  const key = String(data.category ?? data.semanticCategory ?? '').toLowerCase();
  return CATEGORY_ACCENT[key] ?? null;
}

// Vibrant palette: each node role and entity type gets a distinct hue so
// the graph reads as a colourful knowledge map, not a monochrome dot cloud.
function nodeColor(node: GraphNode, activeNodeId?: string | null, highlightedNodes?: Set<string>): string {
  const data = node.data as GraphNodeData;
  // Main entity / root node → deep indigo (the visual anchor)
  if (data.presentationRole === 'main_entity' || data.nodeType === 'root') return '#4f46e5';
  // Active (selected) node → brighter indigo ring
  if (node.id === activeNodeId) return '#6366f1';
  // Highlighted (child subtree) → slightly lighter
  if (highlightedNodes?.has(node.id) || data.isHighlighted) return '#818cf8';
  // Explicit category nodes → vibrant category accent
  if (isExplicitCategoryNode(node)) return categoryAccent(node) ?? '#6366f1';
  // Subcategory → softer shade of same category hue
  if (isSubcategoryNode(node)) return categoryAccent(node) ?? '#a5b4fc';
  // Bucket (+N more) → purple so it reads as "there's more here"
  if (data.isSigmaBucket) return '#a855f7';
  // Entity-type coloring
  const kind = nodeKind(node).toLowerCase();
  if (kind.includes('company'))      return '#3b82f6'; // blue-500
  if (kind.includes('organization')) return '#8b5cf6'; // violet-500
  if (kind.includes('person'))       return '#10b981'; // emerald-500
  if (kind.includes('market'))       return '#f59e0b'; // amber-500
  if (kind.includes('technology'))   return '#6366f1'; // indigo-500
  if (kind.includes('product'))      return '#f97316'; // orange-500
  if (kind.includes('event'))        return '#ef4444'; // red-500
  if (kind.includes('location'))     return '#14b8a6'; // teal-500
  if (kind.includes('regulation'))   return '#f43f5e'; // rose-500
  if (kind.includes('document'))     return '#0ea5e9'; // sky-500
  return '#64748b';                                     // slate-500 fallback
}

// Camera ratio below this value means the user has zoomed in far enough to
// read node labels → expand circles to rectangular cards.
const EXPAND_ZOOM_THRESHOLD = 0.42;

function isAlwaysExpandedNode(node: GraphNode, childCount: number): boolean {
  const data = node.data as GraphNodeData;
  return (
    data.presentationRole === 'main_entity' ||
    data.nodeType === 'root' ||
    isExplicitCategoryNode(node) ||
    childCount >= 4
  );
}

function nodeSize(node: GraphNode, activeNodeId?: string | null, viewMode: 'focused' | 'overview' = 'focused'): number {
  const data = node.data as GraphNodeData;
  const overviewScale = viewMode === 'overview' ? 0.62 : 1;
  if (node.id === activeNodeId) return 26 * overviewScale;                 // active centre — clearly the largest
  if (data.presentationRole === 'main_entity' || data.nodeType === 'root') return 18 * overviewScale;
  if (isExplicitCategoryNode(node)) return 12 * overviewScale;
  if (data.isSigmaBucket) return 11 * overviewScale;
  if (nodeKind(node).toLowerCase().includes('document')) return 9 * overviewScale;
  return 7 * overviewScale;
}

function animDelayMs(item: GraphNode | GraphEdge): number {
  const delay = (item.data as { animDelay?: unknown } | undefined)?.animDelay;
  return typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, delay * 1000) : 0;
}

function pickCenter(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId?: string | null,
  // viewMode kept for signature compatibility but no longer changes behaviour:
  // a single source of truth — the active node — drives the layout centre in
  // both focused and overview modes. This prevents a `pickCenter` mismatch
  // from rendering Acme Corp as a depth-1 child while a different scaffold
  // node sits at the rings' origin.
  _viewMode: 'focused' | 'overview' = 'focused',
): string | null {
  void _viewMode;
  // Always pin the BFS centre to the main entity. Clicking a node updates
  // `activeNodeId` for highlighting + reveal-mode (showing that node's
  // cross-links), but it must NOT recentre the layout — the graph stays
  // anchored so the user has a stable spatial map.
  const main = nodes.find(isMainEntityNode);
  if (main) return main.id;
  if (activeNodeId && nodes.some(node => node.id === activeNodeId)) return activeNodeId;
  const root = nodes.find(node => (node.data as GraphNodeData).nodeType === 'root');
  if (root) return root.id;

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0]?.id ?? null;
}

function edgeKey(edge: GraphEdge, index: number): string {
  return edge.id || `${edge.source}:${edge.target}:${index}`;
}

function isSigmaHaloNodeId(id: string): boolean {
  return id.startsWith(SIGMA_HALO_PREFIX);
}

function formatPredicate(predicate: unknown): string {
  return String(predicate || 'relates to')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLinkableUrl(url: string | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function sourceKind(url: string | undefined): 'web' | 'document' | 'local' | 'unknown' {
  if (!url) return 'unknown';
  if (/^https?:\/\//i.test(url)) return 'web';
  if (/^local:\/\//i.test(url)) return 'document';
  return 'local';
}

function cleanSourceValue(value: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return decoded
    .replace(/^local:\/\//i, '')
    .split(/[?#]/)[0]
    .split('/')
    .pop()!
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sourceLookupKeys(value: string | undefined): string[] {
  if (!value) return [];
  const raw = value.trim();
  if (!raw) return [];
  const cleaned = cleanSourceValue(raw);
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })().replace(/^local:\/\//i, '').trim().toLowerCase();
  return [...new Set([raw.toLowerCase(), decoded, cleaned].filter(Boolean))];
}

function buildDocumentSourceIndex(nodes: GraphNode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    const data = node.data as GraphNodeData;
    const isDocument = data.presentationRole === 'document' || data.description === 'Document' || nodeKind(node).toLowerCase().includes('document');
    if (!isDocument) continue;
    const documentName = typeof data.documentName === 'string' ? data.documentName : undefined;
    for (const key of [
      ...sourceLookupKeys(node.id),
      ...sourceLookupKeys(nodeLabel(node)),
      ...sourceLookupKeys(documentName),
      ...sourceLookupKeys(documentName ? `local://${encodeURIComponent(documentName)}` : undefined),
    ]) {
      index.set(key, node.id);
    }
  }
  return index;
}

function findDocumentNodeIdForSource(
  source: { title?: string; url?: string; snippet?: string },
  documentNodeBySourceKey: Map<string, string>,
): string | undefined {
  for (const key of [
    ...sourceLookupKeys(source.url),
    ...sourceLookupKeys(source.title),
    ...sourceLookupKeys(source.snippet),
  ]) {
    const documentNodeId = documentNodeBySourceKey.get(key);
    if (documentNodeId) return documentNodeId;
  }
  return undefined;
}

function computeBranchLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId?: string | null,
  viewMode: 'focused' | 'overview' = 'focused',
): Map<string, PositionedNode> {
  const positions = new Map<string, PositionedNode>();
  if (nodes.length === 0) return positions;

  const nodeIds = new Set(nodes.map(node => node.id));
  const centerId = pickCenter(nodes, edges, activeNodeId, viewMode) ?? nodes[0].id;
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const undirected = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    undirected.set(node.id, []);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.target)?.push(edge.source);
    undirected.get(edge.source)?.push(edge.target);
    undirected.get(edge.target)?.push(edge.source);
  }

  const depths = new Map<string, number>([[centerId, 0]]);
  const queue = [centerId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextDepth = (depths.get(current) ?? 0) + 1;
    const neighbors = (outgoing.get(current)?.length ? outgoing.get(current) : undirected.get(current)) ?? [];
    for (const neighbor of neighbors) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, nextDepth);
      queue.push(neighbor);
    }
  }

  const maxConnectedDepth = Math.max(0, ...depths.values());
  for (const node of nodes) {
    if (!depths.has(node.id)) depths.set(node.id, maxConnectedDepth + 1);
  }

  // Count how many nodes land at each depth — used to size each ring so the
  // arc between adjacent nodes never becomes too cramped.
  const nodesAtDepth = new Map<number, number>();
  for (const d of depths.values()) nodesAtDepth.set(d, (nodesAtDepth.get(d) ?? 0) + 1);

  const parentByNode = new Map<string, string>();
  for (const node of nodes) {
    if (node.id === centerId) continue;
    const depth = depths.get(node.id) ?? 1;
    const directedParent = (incoming.get(node.id) ?? []).find(parent => (depths.get(parent) ?? 0) < depth);
    const nearbyParent = (undirected.get(node.id) ?? []).find(parent => (depths.get(parent) ?? 0) < depth);
    parentByNode.set(node.id, directedParent ?? nearbyParent ?? centerId);
  }

  const childrenByParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const parentId = parentByNode.get(node.id);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(node);
    childrenByParent.set(parentId, children);
  }

  positions.set(centerId, { id: centerId, x: 0, y: 0, depth: 0, angle: 0 });

  const sortBranchNodes = (items: GraphNode[]) => [...items].sort((a, b) => {
    const aCategory = String((a.data as GraphNodeData).category ?? (a.data as GraphNodeData).semanticCategory ?? '');
    const bCategory = String((b.data as GraphNodeData).category ?? (b.data as GraphNodeData).semanticCategory ?? '');
    const aRole = String((a.data as GraphNodeData).presentationRole ?? '');
    const bRole = String((b.data as GraphNodeData).presentationRole ?? '');
    return aRole.localeCompare(bRole) || aCategory.localeCompare(bCategory) || nodeLabel(a).localeCompare(nodeLabel(b));
  });

  const subtreeSizeMemo = new Map<string, number>();
  const subtreeSize = (nodeId: string): number => {
    const memo = subtreeSizeMemo.get(nodeId);
    if (memo !== undefined) return memo;
    const size = 1 + (childrenByParent.get(nodeId) ?? []).reduce((sum, child) => sum + subtreeSize(child.id), 0);
    subtreeSizeMemo.set(nodeId, size);
    return size;
  };

  // ── Radial tree with sector inheritance ─────────────────────────────────
  // Each node owns an angular sector. Its children are placed within that
  // sector — subtrees can never cross into a sibling's territory, so visual
  // overlap is bounded by construction.
  const sectorWidthOf = new Map<string, number>();
  sectorWidthOf.set(centerId, Math.PI * 2);

  const SECTOR_SIBLING_MARGIN = 0.86; // children get 86% of parent's sector
  // Minimum arc-length gap between adjacent node centers at the same ring.
  const MIN_ARC_GAP = 24;
  // Floor radius per depth level — each ring is at least this far from the
  // previous one so even sparse depths have visible separation.
  const RING_FLOOR_PER_DEPTH = 90;
  // Subtrees with more descendants push their root radially outward; leaves
  // sit at the base ring. This breaks the "all on one circle" pattern.
  const RADIAL_STAGGER = 16;

  // Returns the base ring radius for a given depth + population count.
  // Adaptive: if the node count demands more arc, the ring grows to fit.
  const baseRingRadius = (depth: number): number => {
    const count = nodesAtDepth.get(depth) ?? 1;
    const fromCount = (count * MIN_ARC_GAP) / (2 * Math.PI);
    return Math.max(RING_FLOOR_PER_DEPTH * depth, fromCount);
  };

  const layoutQueue = [centerId];
  while (layoutQueue.length > 0) {
    const parentId = layoutQueue.shift()!;
    const parentPosition = positions.get(parentId);
    if (!parentPosition) continue;
    const sortedChildren = sortBranchNodes(childrenByParent.get(parentId) ?? []);
    if (sortedChildren.length === 0) continue;

    const childDepth = parentPosition.depth + 1;
    const isRootFanout = parentId === centerId;
    const parentSector = sectorWidthOf.get(parentId) ?? Math.PI;

    // Order: at root, interleave by subtree size for balanced visual mass.
    // Deeper, keep the stable label-sorted order so positioning is predictable
    // as the graph grows.
    let ordered = sortedChildren;
    if (isRootFanout) {
      const bySize = [...sortedChildren].sort((a, b) => subtreeSize(b.id) - subtreeSize(a.id));
      const interleaved: GraphNode[] = [];
      let l = 0;
      let r = bySize.length - 1;
      while (l <= r) {
        interleaved.push(bySize[l++]);
        if (l <= r) interleaved.push(bySize[r--]);
      }
      ordered = interleaved;
    }

    // At root: uniform 2π/N sectors so the circle is visually balanced
    // regardless of subtree-size differences (big subtrees no longer pull the
    // graph's centre of mass toward themselves). At deeper levels: weighted
    // sub-sectors so heavy branches still get the angular room they need.
    const availableSpread = isRootFanout
      ? Math.PI * 2
      : parentSector * SECTOR_SIBLING_MARGIN;

    // Sub-linear (sqrt) weighting at every depth so a category with 30
    // children doesn't eat the whole circle, but sparse categories with
    // 1–2 children don't get an oversized empty wedge either. Small
    // categories shrink, big categories grow — both bounded.
    const weights = ordered.map(child => Math.max(1, Math.sqrt(subtreeSize(child.id))));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

    // Where the angular cursor starts. Root: first interleaved child's
    // midpoint at -π/2 (top of canvas). Non-root: centred on the direction
    // the parent grew from its own parent.
    const firstWidth = (weights[0] / totalWeight) * availableSpread;
    const cursorStart = isRootFanout
      ? -Math.PI / 2 - firstWidth / 2
      : parentPosition.angle - availableSpread / 2;
    let cursor = cursorStart;

    // Base ring distance — adaptive to the number of siblings at this depth.
    const baseR = baseRingRadius(childDepth);

    ordered.forEach((child, index) => {
      const sectorWidth = (weights[index] / totalWeight) * availableSpread;
      const angle = cursor + sectorWidth / 2;
      cursor += sectorWidth;

      // Radial stagger: nodes with larger subtrees sit further from the
      // center than leaf nodes at the same depth, breaking the flat-ring
      // look. log2 keeps the spread sub-linear so huge subtrees don't
      // push completely outside the visible area.
      const stagger = Math.log2(subtreeSize(child.id) + 1) * RADIAL_STAGGER;
      const r = baseR + stagger;

      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      positions.set(child.id, { id: child.id, x, y, depth: childDepth, angle });
      sectorWidthOf.set(child.id, sectorWidth);
      layoutQueue.push(child.id);
    });
  }

  return positions;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function nodeAttributes(
  node: GraphNode,
  position: PositionedNode,
  activeNodeId?: string | null,
  highlightedNodes?: Set<string>,
  viewMode: 'focused' | 'overview' = 'focused',
  totalNodes = 0,
): SigmaNodeAttributes {
  const data = node.data as GraphNodeData;
  const isKeyNode =
    node.id === activeNodeId ||
    highlightedNodes?.has(node.id) ||
    data.isHighlighted === true ||
    data.presentationRole === 'main_entity' ||
    data.nodeType === 'root' ||
    isExplicitCategoryNode(node) ||
    data.isSigmaBucket === true;
  // Force labels for the structural backbone (root, active, key, depth ≤ 1).
  // For deeper / non-key nodes, let Sigma's labelDensity collision avoidance
  // decide — that hides labels that would overlap each other rather than
  // jamming them all on top of one another.
  const forceLabel = position.depth === 0
    || node.id === activeNodeId
    || isKeyNode
    || (position.depth === 1 && totalNodes <= 200);

  const isActive = node.id === activeNodeId;
  const isStructural =
    data.presentationRole === 'main_entity' ||
    data.nodeType === 'root' ||
    isExplicitCategoryNode(node);

  return {
    x: position.x,
    y: position.y,
    label: nodeLabel(node),
    size: nodeSize(node, activeNodeId, viewMode),
    color: nodeColor(node, activeNodeId, highlightedNodes),
    forceLabel,
    zIndex: isActive ? 10 : isStructural ? 5 : 1,
    // Active centre gets a larger, bolder, darker label so it reads as the
    // focal point even when surrounded by depth-1 siblings.
    labelSize: isActive ? 18 : isStructural ? 13 : 11,
    labelColor: { color: isActive ? '#ffffff' : '#1e293b' },
    labelWeight: isActive ? 'bold' : 'normal',
  };
}

function edgeRole(edge: GraphEdge): 'bucket' | 'scaffold' | 'bridge' | 'inferred' | 'primary' {
  const label = String(edge.label ?? '').toLowerCase();
  const data = edge.data as { properties?: Record<string, unknown>; sigmaBucket?: unknown; sigmaBucketed?: unknown } | undefined;
  const properties = data?.properties ?? {};
  if (data?.sigmaBucket || data?.sigmaBucketed) return 'bucket';
  if (label === 'expands' || label === 'also connects') return 'bridge';
  if (properties.scaffoldRoute || properties.presentation || properties.synthetic) return 'scaffold';
  if (properties.inferred) return 'inferred';
  return 'primary';
}

function edgeAttributes(edge: GraphEdge, activeNodeId?: string | null, viewMode: 'focused' | 'overview' = 'focused'): SigmaEdgeAttributes {
  const activeEdge = edge.source === activeNodeId || edge.target === activeNodeId;
  const role = edgeRole(edge);
  const edgeConfidence = confidence(edge);
  // Bump the floor opacity so edges remain visible against the light canvas.
  // The earlier 0.26–0.34 values rendered as near-white slate at the chosen
  // base color, which made entire branches look disconnected.
  const confidenceOpacity = edgeConfidence > 0 ? Math.max(0.55, Math.min(1, edgeConfidence)) : 0.78;
  const overviewScale = viewMode === 'overview' ? 0.78 : 1;
  const roleSize = role === 'primary' ? 1.45 : role === 'inferred' ? 1.15 : role === 'scaffold' ? 0.95 : role === 'bucket' ? 0.85 : 0.78;
  const roleOpacity =
    role === 'primary' ? confidenceOpacity :
    role === 'inferred' ? Math.max(0.55, Math.min(0.75, confidenceOpacity)) :
    role === 'scaffold' ? 0.62 :
    role === 'bucket' ? 0.6 :
    0.55;
  const opacity = activeEdge ? Math.max(0.9, roleOpacity) : roleOpacity;
  const color = activeEdge
    ? `rgba(79, 70, 229, ${opacity})`   // indigo-600 for active (matches root color)
    : `rgba(100, 116, 139, ${opacity})`; // slate-500 for the rest
  return {
    size: activeEdge ? Math.max(1.9, roleSize * overviewScale * 1.5) : roleSize * overviewScale,
    color,
    // Empty label by default; the `enterEdge` handler fills + forces the
    // label on hover and `leaveEdge` clears it.
    label: '',
    forceLabel: false,
  };
}

function isStructuralNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  if (data.isSigmaBucket) return true;
  return data.presentationRole === 'main_entity' ||
    isExplicitCategoryNode(node) ||
    isSubcategoryNode(node) ||
    data.nodeType === 'root' ||
    nodeKind(node).toLowerCase().includes('document');
}

function confidence(edge: GraphEdge): number {
  const value = (edge.data as { confidence?: unknown } | undefined)?.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function selectRenderableEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId: string | null | undefined,
  viewMode: 'focused' | 'overview',
): GraphEdge[] {
  const edgeLimit = overviewEdgeLimit(nodes.length);
  if (viewMode === 'focused' || edges.length <= edgeLimit) return edges;

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  return [...edges]
    .sort((a, b) => {
      const score = (edge: GraphEdge) => {
        let total = confidence(edge);
        if (edge.source === activeNodeId || edge.target === activeNodeId) total += 10;
        if (isStructuralNode(nodeById.get(edge.source))) total += 4;
        if (isStructuralNode(nodeById.get(edge.target))) total += 4;
        return total;
      };
      return score(b) - score(a);
    })
    .slice(0, edgeLimit);
}

function graphDegree(edges: GraphEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function nodeImportance(node: GraphNode): number {
  const value = (node.data as GraphNodeData).importance;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nodeLodScore(node: GraphNode, degree: number, activeNodeId?: string | null, highlightedNodes?: Set<string>): number {
  const data = node.data as GraphNodeData;
  let score = degree;
  score += nodeImportance(node) * 24;
  if (node.id === activeNodeId || highlightedNodes?.has(node.id)) score += 200;
  if (data.presentationRole === 'main_entity' || data.nodeType === 'root') score += 160;
  if (isExplicitCategoryNode(node)) score += 90;
  if (data.presentationRole === 'document' || nodeKind(node).toLowerCase().includes('document')) score += 45;
  if (data.isSigmaBucket) score += 80;
  return score;
}

function selectRenderableNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeNodeId: string | null | undefined,
  highlightedNodes: Set<string> | undefined,
  detailMode: DetailMode,
): GraphNode[] {
  if (detailMode === 'full') return nodes;
  const cap = detailMode === 'essential' ? 260 : 720;
  if (nodes.length <= cap) return nodes;

  const degree = graphDegree(edges);
  const keepIds = new Set<string>();
  for (const node of nodes) {
    const data = node.data as GraphNodeData;
    if (
      node.id === activeNodeId ||
      highlightedNodes?.has(node.id) ||
      data.presentationRole === 'main_entity' ||
      isExplicitCategoryNode(node) ||
      data.presentationRole === 'document' ||
      data.nodeType === 'root'
    ) {
      keepIds.add(node.id);
    }
  }

  const ranked = [...nodes]
    .filter(node => !keepIds.has(node.id))
    .sort((a, b) => nodeLodScore(b, degree.get(b.id) ?? 0, activeNodeId, highlightedNodes) - nodeLodScore(a, degree.get(a.id) ?? 0, activeNodeId, highlightedNodes));

  for (const node of ranked) {
    if (keepIds.size >= cap) break;
    keepIds.add(node.id);
  }

  return nodes.filter(node => keepIds.has(node.id));
}

function level1FanoutScore(node: GraphNode, undirectedDegree: number): number {
  const data = node.data as GraphNodeData;
  const importance = typeof data.importance === 'number' ? data.importance : 0;
  let structural = 0;
  if (data.presentationRole === 'main_entity') structural += 100;
  else if (isExplicitCategoryNode(node)) structural += 50;
  else if (nodeKind(node).toLowerCase().includes('document')) structural += 30;
  return structural + importance * 10 + undirectedDegree;
}

function categoryForBucket(node: GraphNode): { key: string; label: string } {
  const data = node.data as GraphNodeData;
  const raw = String(
    data.category ??
    data.semanticCategory ??
    data.presentationCategory ??
    data.description ??
    data.nodeType ??
    'Other Areas',
  ).toLowerCase();
  const kind = nodeKind(node).toLowerCase();

  if (kind.includes('document') || raw.includes('document')) return { key: 'documents', label: 'Documents' };
  if (raw.includes('finance') || raw.includes('revenue') || raw.includes('valuation') || raw.includes('investor')) return { key: 'finance', label: 'Finance' };
  if (raw.includes('legal') || raw.includes('contract') || raw.includes('patent') || raw.includes('compliance')) return { key: 'legal', label: 'Legal & Compliance' };
  if (raw.includes('risk') || kind.includes('risk')) return { key: 'risk', label: 'Risk' };
  if (raw.includes('people') || raw.includes('hr') || raw.includes('employee') || kind.includes('person')) return { key: 'people', label: 'People & HR' };
  if (raw.includes('operation') || raw.includes('supply') || raw.includes('logistics') || raw.includes('warehouse')) return { key: 'operations', label: 'Operations' };
  if (raw.includes('technology') || raw.includes('system') || raw.includes('product') || raw.includes('data')) return { key: 'technology', label: 'Technology & Product' };
  if (raw.includes('market') || raw.includes('customer') || raw.includes('partner') || raw.includes('strategy')) return { key: 'market', label: 'Market & Strategy' };
  return { key: 'other', label: 'Other Areas' };
}

function syntheticBucketNode(centerId: string, key: string, label: string, memberIds: string[]): GraphNode<GraphNodeData> {
  return {
    id: `${SIGMA_BUCKET_PREFIX}${centerId}:${key}`,
    type: 'graphNode',
    position: { x: 0, y: 0 },
    data: {
      label,
      description: 'Grouped Area',
      nodeType: 'topic',
      isSigmaBucket: true,
      memberIds,
      hiddenCount: memberIds.length,
      overview: `${memberIds.length} direct connection${memberIds.length === 1 ? '' : 's'} grouped under ${label}`,
    },
  };
}

// Enforce "only categories at level 1" — drop every direct edge between the
// main entity and a non-category node. Entities that have a category route
// (e.g. via the nest-level-1 AI pass) get re-anchored under their category
// at depth 2. Entities without any category attachment fall outside the
// connected BFS tree and render at the outermost ring until they pick up a
// category edge. The underlying graph data keeps the direct edges intact.
function preferCategoryRoutes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mainEntityId: string | null,
): GraphEdge[] {
  if (!mainEntityId) return edges;
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const isCategory = (id: string): boolean => {
    return isExplicitCategoryNode(nodeById.get(id));
  };

  return edges.filter(edge => {
    const sourceIsMain = edge.source === mainEntityId;
    const targetIsMain = edge.target === mainEntityId;
    if (!sourceIsMain && !targetIsMain) return true;
    const otherEnd = sourceIsMain ? edge.target : edge.source;
    // Keep main_entity ↔ category edges. Drop everything else.
    return isCategory(otherEnd);
  });
}

// Hide non-scaffold (raw entity ↔ entity) edges by default to keep the
// mindmap shape clean. They re-appear only for the currently revealed node
// (the focal entity the user clicked). The data is preserved on the graph
// edges array — we just don't render the lines.
//
// Also dedupes `contains` edges so each entity has exactly one parent — if
// the backend emits the same entity under two categories (race between
// streamed branches), we keep only the highest-confidence one. This ensures
// the radial BFS layout has a strict tree at depth 2, with no children
// drifting into a sibling category's wedge.
function filterToScaffoldEdges(
  edges: GraphEdge[],
  revealedNodeId: string | null,
): GraphEdge[] {
  const containsByTarget = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const label = String(edge.label ?? '').toLowerCase();
    if (label !== 'contains') continue;
    const existing = containsByTarget.get(edge.target);
    if (!existing || confidence(edge) > confidence(existing)) {
      containsByTarget.set(edge.target, edge);
    }
  }
  return edges.filter(edge => {
    const role = edgeRole(edge);
    const label = String(edge.label ?? '').toLowerCase();
    if (label === 'contains') {
      return containsByTarget.get(edge.target) === edge;
    }
    if (role === 'scaffold' || role === 'bucket' || role === 'bridge') return true;
    if (revealedNodeId && (edge.source === revealedNodeId || edge.target === revealedNodeId)) return true;
    return false;
  });
}

function isDocumentNode(node: GraphNode): boolean {
  const data = node.data as GraphNodeData;
  if (data.presentationRole === 'document') return true;
  const desc = String(data.description ?? '').toLowerCase();
  if (desc === 'document') return true;
  const nt = String(data.nodeType ?? '').toLowerCase();
  if (nt === 'document') return true;
  // Also strip the synthetic "Documents" category bucket — with the per-file
  // document nodes removed, this category has nothing left to group and
  // would just dangle as a label-only node.
  const label = String(data.label ?? '').trim().toLowerCase();
  if (label === 'documents' && (isExplicitCategoryNode(node) || data.isSigmaBucket)) return true;
  return false;
}

// Documents are removed from the rendered graph entirely. Each document
// would otherwise become a high-degree mentions-hub that dwarfs the active
// centre. They remain in the underlying graph data and are listed in the
// Contents panel for navigation; clicking one there still focuses its
// related cluster via the existing onNodeFocus path. Edges that previously
// terminated on a document are dropped along with the node by the standard
// `edges.filter(...has(source) && has(target))` step downstream.
function stripDocumentNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter(node => !isDocumentNode(node));
}

// Maximum direct children rendered per parent before overflow gets folded
// into a single bucket node. The orchestrator's adaptive sub-categoriser
// (Phase 2) is the primary tool for keeping the tree readable — it splits
// crowded subtrees into AI-named layers so users can browse hierarchy
// instead of clicking buckets to reveal hidden children. The bucket here
// is a *last-resort* safety valve: only the truly extreme fanouts (20+
// direct children that the sub-categoriser couldn't decompose for some
// reason) get bucketed. Most graphs should never hit this threshold.
const MAX_PARENT_FANOUT = 20;

// Generalised progressive disclosure: every parent (any node that's the
// source of one or more `contains` edges) gets capped at MAX_PARENT_FANOUT
// rendered children. Excess children are folded into a single
// `bucket:<parentId>:more` node so the tree stays browsable even when a
// category or subcategory has 50+ entities. Buckets in `expandedBucketIds`
// stay expanded — their children render normally for that render pass.
function bucketOversizedFanouts(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expandedBucketIds: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    const label = String(edge.label ?? '').toLowerCase();
    if (label !== 'contains') continue;
    const list = childrenByParent.get(edge.source) ?? [];
    list.push(edge.target);
    childrenByParent.set(edge.source, list);
  }

  const oversizedParents: Array<{ parentId: string; children: string[] }> = [];
  for (const [parentId, children] of childrenByParent) {
    if (children.length > MAX_PARENT_FANOUT) {
      oversizedParents.push({ parentId, children });
    }
  }
  if (oversizedParents.length === 0) return { nodes, edges };

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const edgeDegree = graphDegree(edges);

  const newBucketNodes: GraphNode[] = [];
  // childrenIds we want to hide → bucketed; map child → bucket
  const childToBucket = new Map<string, string>();
  // bucketId → parentId (for the synthetic edge)
  const bucketToParent = new Map<string, string>();

  for (const { parentId, children } of oversizedParents) {
    const bucketId = `${SIGMA_BUCKET_PREFIX}${parentId}:more`;
    if (expandedBucketIds.has(bucketId)) continue;

    // Rank children: importance + degree → keep top N visible, bucket the rest.
    const ranked = [...children].sort((a, b) => {
      const nodeA = nodeById.get(a);
      const nodeB = nodeById.get(b);
      const scoreA = (nodeA ? nodeImportance(nodeA) * 24 : 0) + (edgeDegree.get(a) ?? 0);
      const scoreB = (nodeB ? nodeImportance(nodeB) * 24 : 0) + (edgeDegree.get(b) ?? 0);
      return scoreB - scoreA;
    });

    const visibleCount = Math.max(1, MAX_PARENT_FANOUT - 1); // reserve one slot for the bucket
    const overflow = ranked.slice(visibleCount);
    if (overflow.length === 0) continue;

    const parentNode = nodeById.get(parentId);
    const parentLabel = parentNode ? String((parentNode.data as GraphNodeData).label ?? parentId) : parentId;
    const bucket: GraphNode<GraphNodeData> = {
      id: bucketId,
      type: 'graphNode',
      position: { x: 0, y: 0 },
      data: {
        label: `+${overflow.length} more`,
        description: 'Grouped Area',
        nodeType: 'subtopic',
        isSigmaBucket: true,
        memberIds: overflow,
        hiddenCount: overflow.length,
        overview: `${overflow.length} more child${overflow.length === 1 ? '' : 'ren'} under ${parentLabel}. Click to expand.`,
        parentId,
      },
    };
    newBucketNodes.push(bucket);
    bucketToParent.set(bucketId, parentId);
    for (const childId of overflow) childToBucket.set(childId, bucketId);
  }

  if (newBucketNodes.length === 0) return { nodes, edges };

  const bucketedChildIds = new Set(childToBucket.keys());
  // Drop bucketed children + their descendant subtree (transitively, via
  // contains edges originating from them). Otherwise the descendants render
  // floating with no parent. We keep them in the underlying graph; only
  // rendering is gated.
  const adjOutContains = new Map<string, string[]>();
  for (const edge of edges) {
    if (String(edge.label ?? '').toLowerCase() !== 'contains') continue;
    const list = adjOutContains.get(edge.source) ?? [];
    list.push(edge.target);
    adjOutContains.set(edge.source, list);
  }
  const hiddenIds = new Set<string>(bucketedChildIds);
  const stack = [...bucketedChildIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of adjOutContains.get(id) ?? []) {
      if (!hiddenIds.has(child)) {
        hiddenIds.add(child);
        stack.push(child);
      }
    }
  }

  const visibleNodes = nodes.filter(node => !hiddenIds.has(node.id));
  const visibleEdges = edges.filter(edge => !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target));

  // Add the bucket nodes + a `parent → bucket` contains edge so the bucket
  // sits in its parent's wedge and BFS treats it as a normal child.
  const bucketEdges: GraphEdge[] = newBucketNodes.map(bucket => ({
    id: `${(bucket.data as GraphNodeData).parentId}->${bucket.id}`,
    source: String((bucket.data as GraphNodeData).parentId ?? ''),
    target: bucket.id,
    label: 'contains',
    data: {
      confidence: 1,
      sigmaBucket: true,
      properties: { presentation: true, bucketEdge: true },
    },
  }));

  return {
    nodes: [...visibleNodes, ...newBucketNodes],
    edges: [...visibleEdges, ...bucketEdges],
  };
}

// When set, callers should treat any node/edge OUTSIDE the set as "dimmed"
// — render at reduced opacity. `null` means no focal context (full graph
// stays at full opacity).
function computeFocalSet(
  activeNodeId: string | null | undefined,
  isStructuralActive: boolean,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Set<string> | null {
  if (!activeNodeId || isStructuralActive) return null;
  if (!nodes.some(node => node.id === activeNodeId)) return null;

  const set = new Set<string>([activeNodeId]);
  for (const edge of edges) {
    if (edge.source === activeNodeId) set.add(edge.target);
    else if (edge.target === activeNodeId) set.add(edge.source);
  }
  // Walk up the scaffold (`contains` / `has_business_area`) so the path
  // back to the main entity stays bright — the user always sees "where
  // this lives in the tree" even when the rest of the graph dims.
  const incomingScaffold = new Map<string, string>();
  for (const edge of edges) {
    const label = String(edge.label ?? '').toLowerCase();
    if (label !== 'contains' && label !== 'has_business_area') continue;
    incomingScaffold.set(edge.target, edge.source);
  }
  let walker: string | undefined = incomingScaffold.get(activeNodeId);
  const guard = new Set<string>();
  while (walker && !guard.has(walker)) {
    guard.add(walker);
    set.add(walker);
    walker = incomingScaffold.get(walker);
  }
  return set;
}

function applyFocalDim(color: string, focalSet: Set<string> | null, nodeId: string): string {
  if (!focalSet || focalSet.has(nodeId)) return color;
  return colorWithAlpha(color, 0.22);
}

function applyFocalDimEdge(color: string, focalSet: Set<string> | null, source: string, target: string): string {
  if (!focalSet) return color;
  if (focalSet.has(source) && focalSet.has(target)) return color;
  return colorWithAlpha(color, 0.18);
}

function colorWithAlpha(color: string, alpha: number): string {
  // Already rgba? Replace the alpha component.
  const rgba = color.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[0-9.]+\)$/);
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${alpha})`;
  // Hex (#rrggbb or #rgb): convert to rgba.
  const hex = color.replace('#', '');
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

// Determine text color that contrasts well against a given hex bg color.
function contrastText(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? '#1e293b' : '#ffffff';
}

function createNodeCard(
  node: GraphNode,
  onClickNode: (id: string) => void,
): HTMLDivElement {
  const data = node.data as GraphNodeData;
  const bg = nodeColor(node);
  const text = contrastText(bg);
  const label = String(data.label ?? node.id);
  const typeLabel = String(data.description ?? data.nodeType ?? '');

  const card = document.createElement('div');
  card.style.cssText = [
    'position: absolute',
    'display: none',
    'flex-direction: column',
    'gap: 2px',
    'padding: 7px 12px',
    'border-radius: 10px',
    'min-width: 72px',
    'max-width: 180px',
    `background: ${bg}`,
    `color: ${text}`,
    `border: 1.5px solid ${colorWithAlpha(bg, 0.55)}`,
    'box-shadow: 0 3px 12px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.10)',
    'pointer-events: auto',
    'user-select: none',
    'cursor: pointer',
    'font-family: inherit',
    'font-size: 12px',
    'font-weight: 600',
    'line-height: 1.3',
    'overflow: hidden',
    'transition: box-shadow 0.15s ease',
    'will-change: transform',
  ].join('; ');
  // Store current zoom-adjusted scale so hover handlers can read it.
  card.dataset.scale = '1';

  const labelEl = document.createElement('div');
  labelEl.dataset.role = 'label';
  labelEl.textContent = label.length > 24 ? `${label.slice(0, 23)}…` : label;
  labelEl.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  card.appendChild(labelEl);

  if (typeLabel) {
    const typeEl = document.createElement('div');
    typeEl.dataset.role = 'type';
    typeEl.textContent = typeLabel;
    typeEl.style.cssText = 'font-size: 10px; font-weight: 400; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    card.appendChild(typeEl);
  }

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    onClickNode(node.id);
  });
  card.addEventListener('mouseenter', () => {
    const s = parseFloat(card.dataset.scale ?? '1');
    card.style.boxShadow = '0 6px 18px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.14)';
    card.style.transform = `translate(-50%, -50%) scale(${s * 1.05})`;
  });
  card.addEventListener('mouseleave', () => {
    const s = parseFloat(card.dataset.scale ?? '1');
    card.style.boxShadow = '0 3px 12px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.10)';
    card.style.transform = `translate(-50%, -50%) scale(${s})`;
  });

  return card;
}

function bucketCentralFanout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  centerId: string | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!centerId) return { nodes, edges };
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  const directNeighbors = [...(adjacency.get(centerId) ?? [])];
  if (directNeighbors.length <= MAX_LEVEL_1_FANOUT) return { nodes, edges };

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const ranked = [...directNeighbors].sort((a, b) => {
    const nodeA = nodeById.get(a);
    const nodeB = nodeById.get(b);
    if (!nodeA || !nodeB) return 0;
    return level1FanoutScore(nodeB, adjacency.get(b)?.size ?? 0)
      - level1FanoutScore(nodeA, adjacency.get(a)?.size ?? 0);
  });

  const structuralNeighbors = ranked.filter(id => {
    const node = nodeById.get(id);
    return isExplicitCategoryNode(node);
  });

  const keptNeighbors = new Set<string>();
  for (const id of structuralNeighbors.slice(0, Math.max(1, MAX_LEVEL_1_FANOUT - 1))) {
    keptNeighbors.add(id);
  }

  const overflowIds = ranked.filter(id => !keptNeighbors.has(id));
  if (overflowIds.length === 0) return { nodes, edges };

  const groups = new Map<string, { key: string; label: string; memberIds: string[]; score: number }>();
  for (const id of overflowIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    const bucket = categoryForBucket(node);
    const current = groups.get(bucket.key) ?? { ...bucket, memberIds: [], score: 0 };
    current.memberIds.push(id);
    current.score += level1FanoutScore(node, adjacency.get(id)?.size ?? 0);
    groups.set(bucket.key, current);
  }

  const bucketSlots = Math.max(1, MAX_LEVEL_1_FANOUT - keptNeighbors.size);
  const sortedGroups = [...groups.values()].sort((a, b) => b.memberIds.length - a.memberIds.length || b.score - a.score);
  const keptGroups = sortedGroups.slice(0, bucketSlots);
  const overflowGroups = sortedGroups.slice(bucketSlots);
  if (overflowGroups.length > 0) {
    const otherMembers = overflowGroups.flatMap(group => group.memberIds);
    const existingOther = keptGroups.find(group => group.key === 'other');
    if (existingOther) {
      existingOther.memberIds.push(...otherMembers);
    } else if (keptGroups.length > 0) {
      keptGroups[keptGroups.length - 1] = { key: 'other', label: 'Other Areas', memberIds: otherMembers, score: 0 };
    }
  }

  const bucketByMember = new Map<string, GraphNode<GraphNodeData>>();
  const bucketNodes = keptGroups.map(group => {
    const bucket = syntheticBucketNode(centerId, group.key, group.label, group.memberIds);
    for (const memberId of group.memberIds) bucketByMember.set(memberId, bucket);
    return bucket;
  });

  const nextEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const sourceIsCenter = edge.source === centerId;
    const targetIsCenter = edge.target === centerId;
    if (!sourceIsCenter && !targetIsCenter) {
      nextEdges.push(edge);
      continue;
    }

    const neighborId = sourceIsCenter ? edge.target : edge.source;
    if (keptNeighbors.has(neighborId)) {
      nextEdges.push(edge);
      continue;
    }

    const bucket = bucketByMember.get(neighborId);
    if (!bucket) continue;
    nextEdges.push({
      id: `${edge.id || `${edge.source}-${edge.target}`}:bucket:${bucket.id}`,
      source: bucket.id,
      target: neighborId,
      label: edge.label,
      type: edge.type,
      data: {
        ...(edge.data ?? {}),
        sigmaBucketed: true,
      },
    });
  }

  for (const bucket of bucketNodes) {
    nextEdges.push({
      id: `${centerId}->${bucket.id}`,
      source: centerId,
      target: bucket.id,
      label: 'groups',
      data: {
        confidence: 1,
        sigmaBucket: true,
      },
    });
  }

  return {
    nodes: [...nodes, ...bucketNodes],
    edges: nextEdges,
  };
}

function buildEdgeEvidence(
  edge: GraphEdge,
  nodeLabelById: Map<string, string>,
  documentNodeBySourceKey: Map<string, string>,
): EdgeEvidence {
  const data = edge.data as {
    confidence?: unknown;
    sourceLabel?: unknown;
    sources?: Array<{ title?: string; url?: string; snippet?: string }>;
    properties?: Record<string, unknown>;
  } | undefined;
  const properties = data?.properties ?? {};
  const predicate = formatPredicate(edge.label);
  const sourceLabel = nodeLabelById.get(edge.source) ?? edge.source;
  const targetLabel = nodeLabelById.get(edge.target) ?? edge.target;
  const sources = (data?.sources ?? [])
    .map(source => {
      const label = source.title || source.url || source.snippet || 'Source';
      return {
        label,
        url: source.url,
        snippet: source.snippet,
        isLinkable: isLinkableUrl(source.url),
        documentNodeId: findDocumentNodeIdForSource(source, documentNodeBySourceKey),
        kind: sourceKind(source.url),
      };
    });
  const provenance = [
    typeof properties.scaffoldRoute === 'string' ? `Repair: ${formatPredicate(properties.scaffoldRoute)}` : undefined,
    properties.presentation === true ? 'Presentation scaffold' : undefined,
    properties.synthetic === true ? 'Synthetic' : undefined,
    properties.inferred === true ? 'Inferred' : undefined,
    properties.sigmaBucket === true || properties.sigmaBucketed === true ? 'Grouped for display' : undefined,
  ].filter((item): item is string => Boolean(item));

  return {
    title: `${sourceLabel} -> ${targetLabel}`,
    predicate,
    confidence: typeof data?.confidence === 'number' ? data.confidence : undefined,
    agentName: typeof properties.agentName === 'string' ? properties.agentName : undefined,
    category: typeof properties.category === 'string' ? formatPredicate(properties.category) : undefined,
    importance: typeof properties.importance === 'number' ? properties.importance : undefined,
    provenance,
    sourceLabel: typeof data?.sourceLabel === 'string' ? data.sourceLabel : undefined,
    sources,
  };
}

function fitSigmaToNodeIds(renderer: Sigma | null, graph: Graph | null, nodeIds: string[]): void {
  if (!renderer || !graph || nodeIds.length === 0) return;
  const positions = nodeIds
    .filter(nodeId => graph.hasNode(nodeId))
    .map(nodeId => ({
      x: Number(graph.getNodeAttribute(nodeId, 'x')),
      y: Number(graph.getNodeAttribute(nodeId, 'y')),
    }))
    .filter(position => Number.isFinite(position.x) && Number.isFinite(position.y));
  if (positions.length === 0) return;

  const minX = Math.min(...positions.map(position => position.x));
  const maxX = Math.max(...positions.map(position => position.x));
  const minY = Math.min(...positions.map(position => position.y));
  const maxY = Math.max(...positions.map(position => position.y));
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const ratio = Math.max(0.28, Math.min(4.5, span / 8));

  void renderer.getCamera().animate(
    {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      ratio,
    },
    { duration: 360 },
  );
}

function evidenceToText(evidence: EdgeEvidence): string {
  const lines = [
    evidence.title,
    `Predicate: ${evidence.predicate}`,
    evidence.confidence !== undefined ? `Confidence: ${Math.round(evidence.confidence * 100)}%` : undefined,
    evidence.agentName ? `Agent: ${evidence.agentName}` : undefined,
    evidence.category ? `Category: ${evidence.category}` : undefined,
    evidence.importance !== undefined ? `Importance: ${Math.round(evidence.importance * 100)}%` : undefined,
    evidence.provenance.length > 0 ? `Provenance: ${evidence.provenance.join(', ')}` : undefined,
    evidence.sources.length > 0 ? 'Sources:' : undefined,
    ...evidence.sources.flatMap((source, index) => [
      `${index + 1}. [${source.kind}] ${source.label}${source.url ? ` (${source.url})` : ''}`,
      source.snippet ? `   ${source.snippet}` : undefined,
    ]),
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function evidenceToMarkdown(evidence: EdgeEvidence): string {
  const lines = [
    `## ${evidence.title}`,
    '',
    `- Predicate: ${evidence.predicate}`,
    evidence.confidence !== undefined ? `- Confidence: ${Math.round(evidence.confidence * 100)}%` : undefined,
    evidence.agentName ? `- Agent: ${evidence.agentName}` : undefined,
    evidence.category ? `- Category: ${evidence.category}` : undefined,
    evidence.importance !== undefined ? `- Importance: ${Math.round(evidence.importance * 100)}%` : undefined,
    evidence.provenance.length > 0 ? `- Provenance: ${evidence.provenance.join(', ')}` : undefined,
    '',
    evidence.sources.length > 0 ? '### Sources' : undefined,
    ...evidence.sources.flatMap((source, index) => [
      `${index + 1}. **${source.kind}** ${source.url ? `[${source.label}](${source.url})` : source.label}`,
      source.snippet ? `   > ${source.snippet}` : undefined,
    ]),
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function evidenceToJson(evidence: EdgeEvidence): string {
  return JSON.stringify(evidence, null, 2);
}

function copyEvidence(
  evidence: EdgeEvidence,
  format: 'text' | 'markdown' | 'json',
  onCopied: () => void,
): void {
  if (!navigator.clipboard) return;
  const value = format === 'markdown'
    ? evidenceToMarkdown(evidence)
    : format === 'json'
      ? evidenceToJson(evidence)
      : evidenceToText(evidence);
  void navigator.clipboard.writeText(value).then(onCopied);
}

export function SigmaGraphView({
  nodes,
  edges,
  activeNodeId,
  highlightedNodes,
  viewMode = 'focused',
  isStreaming = false,
  onNodeClick,
  onFocusNodes,
  onPaneClick,
}: SigmaGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const seenEdgeIdsRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const positionFrameRef = useRef<number | null>(null);
  const previousNodeCountRef = useRef(0);
  const previousCenterIdRef = useRef<string | null | undefined>(null);
  // Track active-node changes separately from centerId. centerId is pinned
  // to the main entity (so clicks don't recenter the layout), which means
  // it almost never changes — keying camera fly-to off centerChanged would
  // make it fire only once on first paint.
  const previousActiveIdRef = useRef<string | null | undefined>(null);
  const autoFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgeByIdRef = useRef<Map<string, GraphEdge>>(new Map());
  const nodeLabelByIdRef = useRef<Map<string, string>>(new Map());
  const documentNodeBySourceKeyRef = useRef<Map<string, string>>(new Map());
  const virtualBucketIdsRef = useRef<Set<string>>(new Set());
  const bucketMemberIdsRef = useRef<Map<string, string[]>>(new Map());
  const firstSeenAtRef = useRef<Map<string, number>>(new Map());
  // First-paint pulse halos: rAF id keyed by pulse halo node id so we can
  // cancel and clean up on unmount without leaking nodes/frames.
  const pulseFramesRef = useRef<Map<string, number>>(new Map());
  // Continuous breathing animation for the active-centre halo while the
  // orchestrator is still running. The size offset is read by
  // `addOrUpdateActiveHalo` so re-renders preserve the current breath
  // phase instead of snapping back to the static base size.
  const breathingFrameRef = useRef<number | null>(null);
  const breathingOffsetRef = useRef(0);
  const activeHaloIdRef = useRef<string | null>(null);
  const activeHaloBaseSizeRef = useRef(0);
  // Smooth dim transitions: previous focal-set membership + an in-flight
  // rAF id so we can cancel and restart the tween on rapid selection
  // changes. The render path applies target dim immediately; the rAF
  // overrides for ~200ms to interpolate from the previous state.
  const prevFocalSetRef = useRef<Set<string> | null>(null);
  const dimAnimRafRef = useRef<number | null>(null);
  // Per-edge draw-on tween rAF ids so we can cancel/cleanup on unmount and
  // avoid leaking frames if an edge is dropped mid-animation.
  const edgeDrawFramesRef = useRef<Map<string, number>>(new Map());
  const activeNodeIdRef = useRef(activeNodeId);
  const viewModeRef = useRef(viewMode);
  const onNodeClickRef = useRef(onNodeClick);
  const onFocusNodesRef = useRef(onFocusNodes);
  const onPaneClickRef = useRef(onPaneClick);
  // Zoom-responsive card overlay refs
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const overlayCardMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const cameraRatioRef = useRef<number>(1);
  const visibleNodesMapRef = useRef<Map<string, GraphNode>>(new Map());
  const childDegreeRef = useRef<Map<string, number>>(new Map());
  const updateNodeOverlayRef = useRef<(() => void) | null>(null);
  // Track which nodes are currently showing as cards (circle hidden) so we can
  // restore them when they transition back to compact circle mode.
  const cardModeNodesRef = useRef<Set<string>>(new Set());
  // Saved Sigma attributes for nodes that were transitioned to card mode so
  // we can restore them cleanly when reverting to circle mode.
  const originalNodeAttrsRef = useRef<Map<string, { color: string; size: number; label: string }>>(new Map());
  // Tracks the most zoomed-out ratio Sigma has ever used (set on animatedReset)
  // so we can clamp the wheel zoom-out to never exceed "see all nodes".
  const maxSeenRatioRef = useRef<number>(0);

  const [selectedEvidence, setSelectedEvidence] = useState<EdgeEvidence | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<BucketSelection | null>(null);
  const [showAllEvidenceSources, setShowAllEvidenceSources] = useState(false);
  const [copiedEvidence, setCopiedEvidence] = useState(false);
  const [detailMode, setDetailMode] = useState<DetailMode>('balanced');
  // Per-parent overflow buckets the user has expanded — when present, that
  // parent's children render normally instead of being folded into a single
  // "+N more" bucket. Click on the bucket toggles the entry.
  const [expandedBucketIds, setExpandedBucketIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onFocusNodesRef.current = onFocusNodes;
    onPaneClickRef.current = onPaneClick;
    activeNodeIdRef.current = activeNodeId;
    viewModeRef.current = viewMode;
  }, [activeNodeId, onFocusNodes, onNodeClick, onPaneClick, viewMode]);

  // Breathing animation on the focal halo while orchestrator is streaming.
  // Uses sine over a 2.4s period for a calm pulse (~±2.5px on the halo
  // size). When `isStreaming` flips false, eases the offset back to 0 and
  // then stops the rAF.
  useEffect(() => {
    if (!isStreaming) {
      // Decay the offset to 0 so the halo settles instead of snapping.
      const start = performance.now();
      const startOffset = breathingOffsetRef.current;
      const decayDuration = 320;
      const decay = (now: number) => {
        const t = Math.min(1, (now - start) / decayDuration);
        breathingOffsetRef.current = startOffset * (1 - t);
        const haloId = activeHaloIdRef.current;
        if (haloId && graphRef.current?.hasNode(haloId)) {
          graphRef.current.mergeNodeAttributes(haloId, {
            size: activeHaloBaseSizeRef.current + breathingOffsetRef.current,
          });
          rendererRef.current?.refresh();
        }
        if (t < 1) {
          breathingFrameRef.current = requestAnimationFrame(decay);
        } else {
          breathingFrameRef.current = null;
          breathingOffsetRef.current = 0;
        }
      };
      if (breathingFrameRef.current !== null) cancelAnimationFrame(breathingFrameRef.current);
      breathingFrameRef.current = requestAnimationFrame(decay);
      return;
    }
    const start = performance.now();
    const periodMs = 2400;
    const amplitude = 2.5;
    const tick = (now: number) => {
      const phase = ((now - start) / periodMs) * Math.PI * 2;
      breathingOffsetRef.current = Math.sin(phase) * amplitude;
      const haloId = activeHaloIdRef.current;
      if (haloId && graphRef.current?.hasNode(haloId)) {
        graphRef.current.mergeNodeAttributes(haloId, {
          size: activeHaloBaseSizeRef.current + breathingOffsetRef.current,
        });
        rendererRef.current?.refresh();
      }
      breathingFrameRef.current = requestAnimationFrame(tick);
    };
    if (breathingFrameRef.current !== null) cancelAnimationFrame(breathingFrameRef.current);
    breathingFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (breathingFrameRef.current !== null) {
        cancelAnimationFrame(breathingFrameRef.current);
        breathingFrameRef.current = null;
      }
    };
  }, [isStreaming]);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Bubble-phase wheel listener on the wrapper.
  //
  // Sigma's own MouseCaptor calls e.stopPropagation() after it handles a wheel
  // event — so if the scroll originated on the Sigma canvas, Sigma fires first
  // (it's on containerRef in bubble phase) and the event never reaches us here.
  //
  // The ONLY events that reach this listener are those from the HTML card
  // overlay (cards are inside overlayRef, a sibling of containerRef, so they
  // never bubble through containerRef). For those we must:
  //   1. Prevent page scroll (e.preventDefault)
  //   2. Manually drive Sigma's camera using getViewportZoomedState — Sigma's
  //      own zoom-to-cursor logic, guaranteed to produce correct coordinates.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = rendererRef.current as any;
      const container = containerRef.current;
      if (!renderer || !container) return;
      const camera = renderer.getCamera();
      const delta = e.deltaY * -3 / 360;
      if (!delta) return;
      const ZOOMING_RATIO = 1.7;
      const ratioDiff = delta > 0 ? 1 / ZOOMING_RATIO : ZOOMING_RATIO;
      const currentRatio = camera.getState().ratio;
      const maxRatio = Math.max(maxSeenRatioRef.current * 1.1, 1);
      const newRatio = Math.min(Math.max(currentRatio * ratioDiff, 0.01), maxRatio);
      if (currentRatio === newRatio) return;
      const rect = container.getBoundingClientRect();
      const mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const newState = renderer.getViewportZoomedState(mousePos, newRatio);
      camera.animate(newState, { easing: 'quadraticOut', duration: 250 });
    };
    // passive: false required to allow e.preventDefault() for page-scroll prevention.
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Keep the overlay function ref always pointing at the latest closure so the
  // camera + afterRender listeners (registered once) always call current code.
  updateNodeOverlayRef.current = () => {
    const renderer = rendererRef.current;
    const overlay = overlayRef.current;
    const graph = graphRef.current;
    if (!renderer || !overlay || !graph) return;

    const ratio = cameraRatioRef.current;
    let needsRefresh = false;

    for (const [nodeId, card] of overlayCardMapRef.current) {
      if (!graph.hasNode(nodeId) || isSigmaHaloNodeId(nodeId)) {
        card.style.display = 'none';
        continue;
      }
      const node = visibleNodesMapRef.current.get(nodeId);
      if (!node) { card.style.display = 'none'; continue; }

      const childCount = childDegreeRef.current.get(nodeId) ?? 0;
      const alwaysExpanded = isAlwaysExpandedNode(node, childCount);
      const showCard = ratio < EXPAND_ZOOM_THRESHOLD || alwaysExpanded;

      if (!showCard) {
        card.style.display = 'none';
        // Restore Sigma circle if this node was in card mode
        if (cardModeNodesRef.current.has(nodeId)) {
          const original = originalNodeAttrsRef.current.get(nodeId);
          if (original) {
            graph.mergeNodeAttributes(nodeId, original);
            needsRefresh = true;
          }
          cardModeNodesRef.current.delete(nodeId);
        }
        continue;
      }

      // --- Show the card ---
      const nx = graph.getNodeAttribute(nodeId, 'x') as number;
      const ny = graph.getNodeAttribute(nodeId, 'y') as number;
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;

      const vp = renderer.graphToViewport({ x: nx, y: ny });
      card.style.left = `${vp.x}px`;
      card.style.top = `${vp.y}px`;

      // Scale the card exactly like a Sigma circle would scale — proportional
      // to zoom so the card shrinks as you zoom out and grows as you zoom in.
      // Cap at 1.15 so text doesn't become enormous at very high zoom.
      // No minimum floor: the card naturally shrinks to nothing when zoomed far out.
      const scale = Math.min(1.15, EXPAND_ZOOM_THRESHOLD / Math.max(ratio, 0.05));
      card.dataset.scale = String(scale);
      card.style.transform = `translate(-50%, -50%) scale(${scale})`;

      if (card.style.display !== 'flex') card.style.display = 'flex';

      // Hide the underlying Sigma circle so only the HTML card is visible.
      // Also suppress the Sigma label to prevent duplicate text next to circle.
      if (!cardModeNodesRef.current.has(nodeId)) {
        graph.mergeNodeAttributes(nodeId, {
          color: 'rgba(0,0,0,0)',
          size: 0.5,
          label: '',
          forceLabel: false,
        });
        cardModeNodesRef.current.add(nodeId);
        needsRefresh = true;
      }
    }

    // Only call refresh if Sigma graph attributes actually changed.
    // Guard prevents afterRender → updateNodeOverlay → refresh → afterRender loop.
    if (needsRefresh) {
      renderer.refresh();
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    if (!graphRef.current) {
      graphRef.current = new Graph({ multi: true, allowSelfLoops: false });
    }

    if (!rendererRef.current) {
      rendererRef.current = new Sigma(graphRef.current, containerRef.current, {
        allowInvalidContainer: true,
        defaultNodeColor: '#111827',
        defaultEdgeColor: '#9ca3af',
        labelColor: { color: '#111827' },
        labelDensity: 0.12,
        labelRenderedSizeThreshold: 8,
        // Edge labels are off globally — too noisy at scale. We flip
        // `forceLabel: true` on the hovered edge inside `enterEdge` so the
        // predicate appears next to the line without permanently cluttering
        // the canvas.
        renderEdgeLabels: true,
        labelFont: 'inherit',
        edgeLabelSize: 10,
        edgeLabelColor: { color: '#475569' },
        zIndex: true,
      });
      rendererRef.current.on('clickNode', ({ node }) => {
        if (isSigmaHaloNodeId(node)) return;
        setSelectedEvidence(null);
        setShowAllEvidenceSources(false);
        setCopiedEvidence(false);
        // Progressive-disclosure overflow buckets end in `:more`. Click to
        // toggle the parent's overflow open/closed in place. Other buckets
        // (semantic center buckets) keep the legacy behaviour of showing a
        // member list panel.
        if (virtualBucketIdsRef.current.has(node) && node.endsWith(':more')) {
          setExpandedBucketIds(prev => {
            const next = new Set(prev);
            if (next.has(node)) next.delete(node);
            else next.add(node);
            return next;
          });
          setSelectedBucket(null);
          return;
        }
        if (virtualBucketIdsRef.current.has(node)) {
          const memberIds = bucketMemberIdsRef.current.get(node) ?? [];
          if (memberIds.length > 0) {
            onFocusNodesRef.current?.(memberIds);
            fitSigmaToNodeIds(rendererRef.current, graphRef.current, memberIds);
            setSelectedBucket({
              id: node,
              label: String(graphRef.current?.getNodeAttribute(node, 'label') ?? 'Grouped Nodes'),
              members: memberIds
                .filter(memberId => graphRef.current?.hasNode(memberId))
                .map(memberId => ({
                  id: memberId,
                  label: String(graphRef.current?.getNodeAttribute(memberId, 'label') ?? memberId),
                  kind: nodeLabelByIdRef.current.get(memberId) === memberId
                    ? 'Node'
                    : String(nodes.find(item => item.id === memberId)?.data?.description ?? 'Node'),
                }))
                .slice(0, 24),
            });
          }
          return;
        }
        setSelectedBucket(null);
        onNodeClickRef.current?.(node);
      });
      rendererRef.current.on('clickEdge', ({ edge }) => {
        setSelectedBucket(null);
        setShowAllEvidenceSources(false);
        setCopiedEvidence(false);
        const graphEdge = edgeByIdRef.current.get(edge);
        if (graphEdge) setSelectedEvidence(buildEdgeEvidence(graphEdge, nodeLabelByIdRef.current, documentNodeBySourceKeyRef.current));
      });
      rendererRef.current.on('enterNode', ({ node }) => {
        // Halos are decorative; don't change the cursor when hovering them.
        if (isSigmaHaloNodeId(node)) return;
        rendererRef.current!.getContainer().style.cursor = 'pointer';
      });
      rendererRef.current.on('leaveNode', () => {
        rendererRef.current!.getContainer().style.cursor = 'default';
      });
      rendererRef.current.on('enterEdge', ({ edge }) => {
        rendererRef.current!.getContainer().style.cursor = 'pointer';
        const graph = graphRef.current;
        if (graph?.hasEdge(edge)) {
          const graphEdge = edgeByIdRef.current.get(edge);
          const predicate = graphEdge ? formatPredicate(graphEdge.label) : '';
          graph.mergeEdgeAttributes(edge, {
            size: viewModeRef.current === 'overview' ? 2.5 : 3,
            color: '#111827',
            label: predicate,
            forceLabel: true,
          });
          rendererRef.current?.refresh();
        }
      });
      rendererRef.current.on('leaveEdge', ({ edge }) => {
        rendererRef.current!.getContainer().style.cursor = 'default';
        const graph = graphRef.current;
        const graphEdge = edgeByIdRef.current.get(edge);
        if (graph?.hasEdge(edge) && graphEdge) {
          graph.replaceEdgeAttributes(edge, edgeAttributes(graphEdge, activeNodeIdRef.current, viewModeRef.current));
          rendererRef.current?.refresh();
        }
      });
      rendererRef.current.on('clickStage', () => {
        setSelectedEvidence(null);
        setShowAllEvidenceSources(false);
        setCopiedEvidence(false);
        setSelectedBucket(null);
        onPaneClickRef.current?.();
      });
      rendererRef.current.getCamera().animatedReset({ duration: 350 });

      // Zoom-responsive: track camera ratio and sync card overlay positions +
      // Sigma circle visibility on every camera change.
      rendererRef.current.getCamera().on('updated', (state) => {
        cameraRatioRef.current = state.ratio;
        if (state.ratio > maxSeenRatioRef.current) maxSeenRatioRef.current = state.ratio;
        updateNodeOverlayRef.current?.();
      });

      // After every Sigma render, sync card pixel positions so they follow
      // node tween animations without a React render cycle.
      rendererRef.current.on('afterRender', () => {
        updateNodeOverlayRef.current?.();
      });
    }

    const graph = graphRef.current;
    const renderableNodes = selectRenderableNodes(nodes, edges, activeNodeId, highlightedNodes, detailMode);
    // Documents are listed in the Contents panel — keep them out of the
    // rendered graph so they don't dominate the centre with mentions edges.
    const lodNodes = stripDocumentNodes(renderableNodes);
    const lodNodeIds = new Set(lodNodes.map(node => node.id));
    const rawLodEdges = edges.filter(edge => lodNodeIds.has(edge.source) && lodNodeIds.has(edge.target));
    const centerCandidate = pickCenter(lodNodes, rawLodEdges, activeNodeId, viewMode);
    const categoryRouted = preferCategoryRoutes(lodNodes, rawLodEdges, centerCandidate);
    // Reveal cross-links only for entity-level focal nodes — keep the canvas
    // calm when the user is at the main entity or browsing a category.
    const activeNode = activeNodeId ? lodNodes.find(n => n.id === activeNodeId) : undefined;
    const isStructuralActive = activeNode
      ? ((activeNode.data as GraphNodeData).presentationRole === 'main_entity'
        || isExplicitCategoryNode(activeNode)
        || isSubcategoryNode(activeNode))
      : true;
    const revealedNodeId = isStructuralActive ? null : (activeNodeId ?? null);
    const lodEdges = filterToScaffoldEdges(categoryRouted, revealedNodeId);
    const centerId = centerCandidate;
    const centerBucketed = bucketCentralFanout(lodNodes, lodEdges, centerId);
    // Progressive disclosure: cap fanout at every depth, not just the root.
    // Buckets the user has expanded stay flat for this render pass.
    const fanoutBucketed = bucketOversizedFanouts(
      centerBucketed.nodes,
      centerBucketed.edges,
      expandedBucketIds,
    );
    const visibleNodes = fanoutBucketed.nodes;
    const visibleEdges = fanoutBucketed.edges;

    // Focal-context dim: when the user has selected an entity, fade
    // everything that isn't the active node, its 1-hop neighbours via any
    // edge, or its scaffold ancestors back to the centre. Keeps the layout
    // perfectly stable while making "what is this connected to and where
    // does it live" pop visually. When no selection (or the active node is
    // structural / the centre), the whole graph stays at full strength.
    const focalSet = computeFocalSet(activeNodeId, isStructuralActive, visibleNodes, visibleEdges);
    rendererRef.current.setSettings(sigmaLabelSettings(visibleNodes.length, viewMode));
    const haloId = centerId ? `${SIGMA_HALO_PREFIX}${centerId}` : null;
    // A second, smaller halo follows the user-selected node when it isn't
    // the centre — gives the focal entity a clear ring/glow so it pops above
    // its category siblings.
    const activeHaloId = activeNodeId && activeNodeId !== centerId
      ? `${SIGMA_HALO_PREFIX}active:${activeNodeId}`
      : null;
    const nodeIds = new Set(visibleNodes.map(node => node.id));
    if (haloId) nodeIds.add(haloId);
    if (activeHaloId) nodeIds.add(activeHaloId);
    const renderableEdges = selectRenderableEdges(visibleNodes, visibleEdges, activeNodeId, viewMode);
    const edgeIds = new Set(renderableEdges.map(edgeKey));
    const positions = computeBranchLayout(visibleNodes, renderableEdges, activeNodeId, viewMode);
    nodeLabelByIdRef.current = new Map(visibleNodes.map(node => [node.id, nodeLabel(node)]));
    documentNodeBySourceKeyRef.current = buildDocumentSourceIndex(nodes);
    edgeByIdRef.current = new Map(renderableEdges.map((edge, index) => [edgeKey(edge, index), edge]));
    virtualBucketIdsRef.current = new Set(visibleNodes.filter(node => (node.data as GraphNodeData).isSigmaBucket).map(node => node.id));
    bucketMemberIdsRef.current = new Map(
      visibleNodes
        .filter(node => (node.data as GraphNodeData).isSigmaBucket)
        .map(node => [
          node.id,
          Array.isArray((node.data as GraphNodeData).memberIds)
            ? ((node.data as GraphNodeData).memberIds as unknown[]).filter((id): id is string => typeof id === 'string')
            : [],
        ]),
    );

    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current = [];
    if (positionFrameRef.current !== null) {
      cancelAnimationFrame(positionFrameRef.current);
      positionFrameRef.current = null;
    }

    const shouldAnimatePositions = viewMode === 'focused' && visibleNodes.length <= 500;
    const nodeTweens: NodeTween[] = [];
    const centerPosition = centerId ? positions.get(centerId) : undefined;

    const edgesToDrop: string[] = [];
    const nodesToDrop: string[] = [];
    graph.forEachEdge(edgeId => {
      if (!edgeIds.has(String(edgeId))) edgesToDrop.push(String(edgeId));
    });
    graph.forEachNode(nodeId => {
      const id = String(nodeId);
      // Transient first-paint pulse halos own their own rAF lifecycle and
      // self-remove on completion. Skip them here so a re-render that fires
      // before the rAF finishes doesn't yank them out mid-pulse.
      if (id.startsWith(`${SIGMA_HALO_PREFIX}pulse:`)) return;
      if (!nodeIds.has(id)) nodesToDrop.push(id);
    });
    edgesToDrop.forEach(edgeId => graph.dropEdge(edgeId));
    nodesToDrop.forEach(nodeId => graph.dropNode(nodeId));

    // Clean up overlay cards and card-mode state for nodes dropped from the graph.
    nodesToDrop.forEach(nodeId => {
      const card = overlayCardMapRef.current.get(nodeId);
      if (card) {
        card.remove();
        overlayCardMapRef.current.delete(nodeId);
      }
      cardModeNodesRef.current.delete(nodeId);
      originalNodeAttrsRef.current.delete(nodeId);
    });

    // Keep up-to-date maps used by updateNodeOverlay.
    visibleNodesMapRef.current = new Map(visibleNodes.map(n => [n.id, n]));
    const degMap = new Map<string, number>();
    for (const edge of visibleEdges) {
      degMap.set(edge.source, (degMap.get(edge.source) ?? 0) + 1);
      degMap.set(edge.target, (degMap.get(edge.target) ?? 0) + 1);
    }
    childDegreeRef.current = degMap;

    const addOrUpdateHalo = () => {
      if (!haloId || !centerId) return;
      const centerPosition = positions.get(centerId);
      if (!centerPosition) return;
      const restSize = viewMode === 'overview' ? 18 : 26;
      // When the user hasn't clicked into a deeper node, the centre halo
      // doubles as the focal halo — breathe it instead of the active halo.
      const breatheCenter = !activeNodeId || activeNodeId === centerId;
      if (breatheCenter) {
        activeHaloIdRef.current = haloId;
        activeHaloBaseSizeRef.current = restSize;
      }
      const attrs: SigmaNodeAttributes = {
        x: centerPosition.x,
        y: centerPosition.y,
        label: '',
        size: restSize + (breatheCenter ? breathingOffsetRef.current : 0),
        color: 'rgba(79, 70, 229, 0.18)',
        forceLabel: false,
        zIndex: 0,
      };
      if (graph.hasNode(haloId)) {
        graph.replaceNodeAttributes(haloId, attrs);
      } else {
        graph.addNode(haloId, attrs);
      }
    };
    const addOrUpdateActiveHalo = () => {
      if (!activeHaloId || !activeNodeId) return;
      const activePosition = positions.get(activeNodeId);
      if (!activePosition) return;
      // Halo radius = node size + a fixed gap so the ring reads as a clear
      // outline regardless of the node's depth.
      const activeNode = visibleNodes.find(node => node.id === activeNodeId);
      const baseSize = activeNode ? nodeSize(activeNode, activeNodeId, viewMode) : 8;
      const restSize = baseSize + (viewMode === 'overview' ? 4 : 6);
      activeHaloIdRef.current = activeHaloId;
      activeHaloBaseSizeRef.current = restSize;
      const attrs: SigmaNodeAttributes = {
        x: activePosition.x,
        y: activePosition.y,
        label: '',
        size: restSize + breathingOffsetRef.current,
        color: 'rgba(99, 102, 241, 0.20)',
        forceLabel: false,
        zIndex: 0,
      };
      if (graph.hasNode(activeHaloId)) {
        graph.replaceNodeAttributes(activeHaloId, attrs);
      } else {
        graph.addNode(activeHaloId, attrs);
      }
    };

    const spawnFirstPaintPulse = (node: GraphNode, position: { x: number; y: number }) => {
      // Skip in overview — large graphs would spawn dozens of concurrent
      // pulses, which is noisy and burns frames.
      if (viewMode !== 'focused') return;
      if (!rendererRef.current) return;
      const pulseId = `${SIGMA_HALO_PREFIX}pulse:${node.id}`;
      if (graph.hasNode(pulseId)) return;
      const baseSize = nodeSize(node, activeNodeIdRef.current ?? null, viewMode);
      const startSize = baseSize * 1.7;
      graph.addNode(pulseId, {
        x: position.x,
        y: position.y,
        label: '',
        size: startSize,
        color: 'rgba(15, 23, 42, 0.32)',
        forceLabel: false,
        zIndex: 0,
      });
      const start = performance.now();
      const duration = 600;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const alpha = 0.32 * (1 - eased);
        const size = startSize - (startSize - baseSize) * eased;
        if (graphRef.current?.hasNode(pulseId)) {
          graphRef.current.mergeNodeAttributes(pulseId, {
            size,
            color: `rgba(15, 23, 42, ${alpha.toFixed(3)})`,
          });
        }
        rendererRef.current?.refresh();
        if (t < 1) {
          pulseFramesRef.current.set(pulseId, requestAnimationFrame(step));
        } else {
          pulseFramesRef.current.delete(pulseId);
          if (graphRef.current?.hasNode(pulseId)) graphRef.current.dropNode(pulseId);
          rendererRef.current?.refresh();
        }
      };
      pulseFramesRef.current.set(pulseId, requestAnimationFrame(step));
    };

    const addOrUpdateNode = (node: GraphNode) => {
      const position = positions.get(node.id) ?? { id: node.id, x: 0, y: 0, depth: 0, angle: 0 };
      const baseAttrs = nodeAttributes(node, position, activeNodeId, highlightedNodes, viewMode, visibleNodes.length);
      // Force labels for every node in the focal set so the user can read
      // the names of all connected entities at a glance once they've
      // selected a node. Also set a slightly stronger label colour so the
      // neighbourhood pops over the dimmed background.
      const inFocalSet = focalSet?.has(node.id) ?? false;
      const focalLabelOverride = focalSet && inFocalSet && node.id !== activeNodeId
        ? { forceLabel: true, labelColor: { color: '#0f172a' } }
        : null;
      const attrs: SigmaNodeAttributes = focalSet
        ? { ...baseAttrs, ...(focalLabelOverride ?? {}), color: applyFocalDim(baseAttrs.color, focalSet, node.id) }
        : baseAttrs;
      const firstSeenAt = firstSeenAtRef.current.get(node.id);
      const isSticky = firstSeenAt !== undefined && performance.now() - firstSeenAt > STICKY_NODE_AFTER_MS && centerId === previousCenterIdRef.current;
      // Save the "intended" attrs for this node so updateNodeOverlay can
      // restore them when the node transitions back from card → circle mode.
      if (!isSigmaHaloNodeId(node.id)) {
        originalNodeAttrsRef.current.set(node.id, {
          color: attrs.color,
          size: attrs.size,
          label: attrs.label ?? '',
        });
      }

      if (!graph.hasNode(node.id)) {
        const startX = shouldAnimatePositions ? (centerPosition?.x ?? attrs.x) : attrs.x;
        const startY = shouldAnimatePositions ? (centerPosition?.y ?? attrs.y) : attrs.y;
        graph.addNode(node.id, { ...attrs, x: startX, y: startY });
        firstSeenAtRef.current.set(node.id, performance.now());
        if (shouldAnimatePositions) {
          nodeTweens.push({ id: node.id, fromX: startX, fromY: startY, toX: attrs.x, toY: attrs.y });
        }
        // Brief halo pulse on first paint so a node arriving via SSE reads
        // as "something appeared" rather than just popping in. The pulse
        // self-removes after 600ms and is skipped in overview mode.
        spawnFirstPaintPulse(node, { x: attrs.x, y: attrs.y });
        // Create HTML overlay card for this new node (shown when zoomed in or
        // when the node is a structural "always expanded" node).
        if (!isSigmaHaloNodeId(node.id) && !overlayCardMapRef.current.has(node.id) && overlayRef.current) {
          const card = createNodeCard(
            node,
            (id) => { onNodeClickRef.current?.(id); },
          );
          overlayRef.current.appendChild(card);
          overlayCardMapRef.current.set(node.id, card);
        }
      } else {
        const current = graph.getNodeAttributes(node.id) as Partial<SigmaNodeAttributes>;
        const fromX = typeof current.x === 'number' ? current.x : attrs.x;
        const fromY = typeof current.y === 'number' ? current.y : attrs.y;
        const targetX = isSticky ? fromX : attrs.x;
        const targetY = isSticky ? fromY : attrs.y;
        graph.replaceNodeAttributes(node.id, shouldAnimatePositions ? { ...attrs, x: fromX, y: fromY } : { ...attrs, x: targetX, y: targetY });
        if (shouldAnimatePositions && !isSticky && (Math.abs(fromX - attrs.x) > 0.01 || Math.abs(fromY - attrs.y) > 0.01)) {
          nodeTweens.push({ id: node.id, fromX, fromY, toX: attrs.x, toY: attrs.y });
        }
      }

      // If this node is currently in card mode, re-apply the hidden-circle
      // state immediately after the graph update (prevents a flash where the
      // circle briefly reappears during graph re-renders).
      if (!isSigmaHaloNodeId(node.id) && cardModeNodesRef.current.has(node.id) && graph.hasNode(node.id)) {
        graph.mergeNodeAttributes(node.id, {
          color: 'rgba(0,0,0,0)',
          size: 0.5,
          label: '',
          forceLabel: false,
        });
      }
    };

    const spawnEdgeDrawOn = (edgeId: string, targetSize: number, targetColor: string) => {
      // Lightweight "draw-on" tween: grow edge size 0 → target and fade
      // alpha 0 → 1 over 360ms. Not a true stroke-dasharray reveal (Sigma's
      // default edge programs don't expose progress), but reads as the
      // edge appearing rather than popping.
      if (viewMode !== 'focused') return;
      if (!graphRef.current?.hasEdge(edgeId)) return;
      const start = performance.now();
      const duration = 360;
      // Initialise at zero state so the first frame doesn't flash full-size.
      graphRef.current.mergeEdgeAttributes(edgeId, {
        size: 0.01,
        color: colorWithAlpha(targetColor, 0),
      });
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = easeOutCubic(t);
        if (graphRef.current?.hasEdge(edgeId)) {
          graphRef.current.mergeEdgeAttributes(edgeId, {
            size: Math.max(0.01, targetSize * eased),
            color: colorWithAlpha(targetColor, eased),
          });
        }
        rendererRef.current?.refresh();
        if (t < 1) {
          edgeDrawFramesRef.current.set(edgeId, requestAnimationFrame(tick));
        } else {
          edgeDrawFramesRef.current.delete(edgeId);
          // Restore final attrs so the dim/highlight tween paths can take
          // over cleanly without the easing residue.
          if (graphRef.current?.hasEdge(edgeId)) {
            graphRef.current.mergeEdgeAttributes(edgeId, { size: targetSize, color: targetColor });
            rendererRef.current?.refresh();
          }
        }
      };
      edgeDrawFramesRef.current.set(edgeId, requestAnimationFrame(tick));
    };

    const addOrUpdateEdge = (edge: GraphEdge, index: number) => {
      const id = edgeKey(edge, index);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) return;
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return;
      const baseEdgeAttrs = edgeAttributes(edge, activeNodeId, viewMode);
      const attrs: SigmaEdgeAttributes = focalSet
        ? { ...baseEdgeAttrs, color: applyFocalDimEdge(baseEdgeAttrs.color, focalSet, edge.source, edge.target) }
        : baseEdgeAttrs;
      const isNewEdgeInGraph = !graph.hasEdge(id);
      if (isNewEdgeInGraph) {
        graph.addEdgeWithKey(id, edge.source, edge.target, attrs);
        spawnEdgeDrawOn(id, attrs.size ?? 1, attrs.color);
      } else {
        graph.replaceEdgeAttributes(id, attrs);
      }
    };

    addOrUpdateHalo();
    addOrUpdateActiveHalo();

    visibleNodes.forEach(node => {
      const isNew = !seenNodeIdsRef.current.has(node.id);
      const delay = isNew && viewMode === 'focused' ? animDelayMs(node) : 0;
      seenNodeIdsRef.current.add(node.id);
      if (delay === 0) {
        addOrUpdateNode(node);
      } else {
        timersRef.current.push(setTimeout(() => {
          addOrUpdateNode(node);
          rendererRef.current?.refresh();
        }, delay));
      }
    });

    renderableEdges.forEach((edge, index) => {
      const id = edgeKey(edge, index);
      const isNew = !seenEdgeIdsRef.current.has(id);
      const delay = isNew && viewMode === 'focused' ? animDelayMs(edge) : 0;
      seenEdgeIdsRef.current.add(id);
      if (delay === 0) {
        addOrUpdateEdge(edge, index);
      } else {
        timersRef.current.push(setTimeout(() => {
          addOrUpdateEdge(edge, index);
          rendererRef.current?.refresh();
        }, delay));
      }
    });

    if (nodeTweens.length > 0) {
      const renderer = rendererRef.current;
      const start = performance.now();
      const duration = Math.min(680, Math.max(260, 620 - visibleNodes.length * 0.45));
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = easeOutCubic(t);
        for (const tween of nodeTweens) {
          if (!graph.hasNode(tween.id)) continue;
          graph.mergeNodeAttributes(tween.id, {
            x: tween.fromX + (tween.toX - tween.fromX) * eased,
            y: tween.fromY + (tween.toY - tween.fromY) * eased,
          });
        }
        renderer?.refresh();
        if (t < 1) {
          positionFrameRef.current = requestAnimationFrame(step);
        } else {
          positionFrameRef.current = null;
        }
      };
      positionFrameRef.current = requestAnimationFrame(step);
    } else {
      rendererRef.current.refresh();
    }

    // Smooth dim transition: tween non-focal node/edge alpha for 200ms when
    // the focal set changes (selection made, cleared, or moved to another
    // node). The render path above already applied the target dim; this
    // rAF overrides for the transition window.
    {
      const prev = prevFocalSetRef.current;
      const curr = focalSet;
      const sameSet = prev === curr || (
        prev !== null && curr !== null && prev.size === curr.size && [...prev].every(id => curr.has(id))
      );
      if (!sameSet) {
        if (dimAnimRafRef.current !== null) cancelAnimationFrame(dimAnimRafRef.current);
        const NODE_DIM_ALPHA = 0.22;
        const EDGE_DIM_ALPHA = 0.18;
        type DimEntry = { id: string; from: number; to: number; base: string };
        const nodeEntries: DimEntry[] = [];
        for (const node of visibleNodes) {
          const wasFocal = prev === null || prev.has(node.id);
          const isFocal = curr === null || curr.has(node.id);
          if (wasFocal === isFocal) continue;
          const baseColor = nodeAttributes(
            node,
            positions.get(node.id) ?? { id: node.id, x: 0, y: 0, depth: 0, angle: 0 },
            activeNodeId,
            highlightedNodes,
            viewMode,
            visibleNodes.length,
          ).color;
          nodeEntries.push({
            id: node.id,
            from: wasFocal ? 1 : NODE_DIM_ALPHA,
            to: isFocal ? 1 : NODE_DIM_ALPHA,
            base: baseColor,
          });
        }
        const edgeEntries: DimEntry[] = [];
        renderableEdges.forEach((edge, index) => {
          const id = edgeKey(edge, index);
          const wasFocal = prev === null || (prev.has(edge.source) && prev.has(edge.target));
          const isFocal = curr === null || (curr.has(edge.source) && curr.has(edge.target));
          if (wasFocal === isFocal) return;
          const baseColor = edgeAttributes(edge, activeNodeId, viewMode).color;
          edgeEntries.push({
            id,
            from: wasFocal ? 1 : EDGE_DIM_ALPHA,
            to: isFocal ? 1 : EDGE_DIM_ALPHA,
            base: baseColor,
          });
        });
        if (nodeEntries.length > 0 || edgeEntries.length > 0) {
          const dimStart = performance.now();
          const dimDuration = 200;
          const dimTick = (now: number) => {
            const t = Math.min(1, (now - dimStart) / dimDuration);
            const eased = easeOutCubic(t);
            for (const e of nodeEntries) {
              if (!graph.hasNode(e.id)) continue;
              const alpha = e.from + (e.to - e.from) * eased;
              graph.mergeNodeAttributes(e.id, { color: colorWithAlpha(e.base, alpha) });
            }
            for (const e of edgeEntries) {
              if (!graph.hasEdge(e.id)) continue;
              const alpha = e.from + (e.to - e.from) * eased;
              graph.mergeEdgeAttributes(e.id, { color: colorWithAlpha(e.base, alpha) });
            }
            rendererRef.current?.refresh();
            if (t < 1) {
              dimAnimRafRef.current = requestAnimationFrame(dimTick);
            } else {
              dimAnimRafRef.current = null;
            }
          };
          dimAnimRafRef.current = requestAnimationFrame(dimTick);
        }
      }
      prevFocalSetRef.current = focalSet ? new Set(focalSet) : null;
    }

    const wasEmpty = previousNodeCountRef.current === 0;
    const centerChanged = previousCenterIdRef.current !== centerId;
    const activeChanged = previousActiveIdRef.current !== activeNodeId;
    const nodeCountChanged = previousNodeCountRef.current !== visibleNodes.length;
    previousNodeCountRef.current = visibleNodes.length;
    previousCenterIdRef.current = centerId;
    previousActiveIdRef.current = activeNodeId;

    // Fly-to target: prefer the user-selected active node so clicking a
    // deep entity actually flies the camera to it. Falls back to centerId
    // for the first-paint case (when no active node has been picked yet).
    const flyToId = activeChanged && activeNodeId
      ? activeNodeId
      : (centerChanged && centerId ? centerId : null);
    if (wasEmpty && visibleNodes.length > 0) {
      void rendererRef.current.getCamera().animatedReset({ duration: 420 });
    } else if (flyToId) {
      // Camera fly-to: focus on the new active/centre node + its immediate
      // neighbours instead of resetting to full-graph bounds. Reads target
      // positions from the layout `positions` map (not the Sigma graph
      // attrs) so the fit target is the post-tween bbox. The 1200ms
      // auto-fit timer below still re-frames everything once the stream
      // settles, so growth-time framing is unaffected.
      const focusIds = new Set<string>([flyToId]);
      for (const edge of renderableEdges) {
        if (edge.source === flyToId) focusIds.add(edge.target);
        else if (edge.target === flyToId) focusIds.add(edge.source);
      }
      const points = [...focusIds]
        .map(id => positions.get(id))
        .filter((p): p is { x: number; y: number; id: string; depth: number; angle: number } => Boolean(p));
      if (points.length > 0) {
        const minX = Math.min(...points.map(p => p.x));
        const maxX = Math.max(...points.map(p => p.x));
        const minY = Math.min(...points.map(p => p.y));
        const maxY = Math.max(...points.map(p => p.y));
        const span = Math.max(maxX - minX, maxY - minY, 1);
        const ratio = Math.max(0.32, Math.min(2.4, span / 8));
        void rendererRef.current.getCamera().animate(
          { x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio },
          { duration: 520, easing: 'cubicInOut' },
        );
      }
    }

    // Auto-fit while the graph is still growing: schedule a reset ~1200ms
    // after the last node-count change. Cancelled by the next change, so it
    // only fires after the stream goes quiet — matches "extraction settled,
    // re-frame everything in view." Only re-schedule when the node count
    // actually changed; otherwise selection-only re-renders would keep
    // bumping the timer and eventually override the fly-to.
    if (nodeCountChanged && autoFitTimerRef.current) {
      clearTimeout(autoFitTimerRef.current);
      autoFitTimerRef.current = null;
    }
    if (nodeCountChanged && visibleNodes.length > 0) {
      autoFitTimerRef.current = setTimeout(() => {
        autoFitTimerRef.current = null;
        rendererRef.current?.getCamera().animatedReset({ duration: 380 });
      }, 1200);
    }
  }, [nodes, edges, activeNodeId, highlightedNodes, viewMode, detailMode, expandedBucketIds]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer));
      timersRef.current = [];
      if (positionFrameRef.current !== null) {
        cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
      if (autoFitTimerRef.current) {
        clearTimeout(autoFitTimerRef.current);
        autoFitTimerRef.current = null;
      }
      pulseFramesRef.current.forEach(frame => cancelAnimationFrame(frame));
      pulseFramesRef.current.clear();
      if (breathingFrameRef.current !== null) {
        cancelAnimationFrame(breathingFrameRef.current);
        breathingFrameRef.current = null;
      }
      if (dimAnimRafRef.current !== null) {
        cancelAnimationFrame(dimAnimRafRef.current);
        dimAnimRafRef.current = null;
      }
      edgeDrawFramesRef.current.forEach(frame => cancelAnimationFrame(frame));
      edgeDrawFramesRef.current.clear();
      rendererRef.current?.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0"
      style={{
        // Reserve space at the bottom so Sigma's auto-fit doesn't park
        // graph nodes underneath the floating query bar.
        paddingBottom: nodes.length > 0 ? 150 : 0,
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {/* HTML card overlay — cards are created imperatively and positioned via afterRender */}
      <div
        ref={overlayRef}
        className="absolute inset-0 overflow-hidden"
        style={{ pointerEvents: 'none', zIndex: 5 }}
      />
      {nodes.length > 0 && (
        <div className="absolute bottom-4 right-4 z-20 flex flex-col items-end gap-2">
          <div
            className="flex flex-col overflow-hidden rounded-xl"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
            }}
          >
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)' }}
              title="Zoom in"
              onClick={() => void rendererRef.current?.getCamera().animatedZoom({ duration: 160, factor: 1.45 })}
            >
              <Plus size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center border-t transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)', borderColor: 'var(--kg-node-border)' }}
              title="Zoom out"
              onClick={() => void rendererRef.current?.getCamera().animatedUnzoom({ duration: 160, factor: 1.45 })}
            >
              <Minus size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center border-t transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)', borderColor: 'var(--kg-node-border)' }}
              title="Fit graph"
              onClick={() => void rendererRef.current?.getCamera().animatedReset({ duration: 280 })}
            >
              <Maximize2 size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
      {selectedEvidence && (
        <div
          className="absolute left-5 bottom-36 z-20 w-[min(360px,calc(100vw-40px))] rounded-xl p-4"
          style={{
            background: 'var(--kg-node-bg)',
            border: '1px solid var(--kg-node-border)',
            boxShadow: 'var(--kg-shadow-lg)',
            color: 'var(--foreground)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                Relationship Evidence
              </div>
              <div className="mt-1 text-sm font-semibold leading-snug">{selectedEvidence.title}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {(['text', 'markdown', 'json'] as const).map(format => (
                <button
                  key={format}
                  type="button"
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium uppercase transition-colors hover:bg-accent"
                  title={`Copy ${format}`}
                  onClick={() => copyEvidence(selectedEvidence, format, () => {
                    setCopiedEvidence(true);
                    window.setTimeout(() => setCopiedEvidence(false), 1400);
                  })}
                >
                  {copiedEvidence ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
                  {format === 'markdown' ? 'md' : format}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
              title="Close evidence"
              onClick={() => {
                setSelectedEvidence(null);
                setShowAllEvidenceSources(false);
                setCopiedEvidence(false);
              }}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="mt-3 grid gap-2 text-xs">
            <div>
              <span style={{ color: 'var(--muted-foreground)' }}>Predicate: </span>
              <span className="font-medium">{selectedEvidence.predicate}</span>
            </div>
            {selectedEvidence.confidence !== undefined && (
              <div>
                <span style={{ color: 'var(--muted-foreground)' }}>Confidence: </span>
                <span className="font-medium">{Math.round(selectedEvidence.confidence * 100)}%</span>
              </div>
            )}
            {(selectedEvidence.agentName || selectedEvidence.category || selectedEvidence.importance !== undefined) && (
              <div className="flex flex-wrap gap-1.5">
                {selectedEvidence.agentName && (
                  <span
                    className="rounded-full px-2 py-0.5 font-medium"
                    style={{ background: 'var(--secondary)', color: 'var(--foreground)' }}
                  >
                    {selectedEvidence.agentName}
                  </span>
                )}
                {selectedEvidence.category && (
                  <span
                    className="rounded-full px-2 py-0.5 font-medium"
                    style={{ background: 'var(--secondary)', color: 'var(--foreground)' }}
                  >
                    {selectedEvidence.category}
                  </span>
                )}
                {selectedEvidence.importance !== undefined && (
                  <span
                    className="rounded-full px-2 py-0.5 font-medium"
                    style={{ background: 'var(--secondary)', color: 'var(--foreground)' }}
                  >
                    Importance {Math.round(selectedEvidence.importance * 100)}%
                  </span>
                )}
              </div>
            )}
            {selectedEvidence.provenance.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedEvidence.provenance.map(item => (
                  <span
                    key={item}
                    className="rounded-full px-2 py-0.5"
                    style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
            {selectedEvidence.sourceLabel && (
              <div>
                <span style={{ color: 'var(--muted-foreground)' }}>Source: </span>
                <span className="font-medium">{selectedEvidence.sourceLabel}</span>
              </div>
            )}
            {selectedEvidence.sources.length > 0 && (
              <div className="mt-1 space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                  Source previews
                </div>
                {(showAllEvidenceSources ? selectedEvidence.sources : selectedEvidence.sources.slice(0, 3)).map((source, index) => (
                  <div
                    key={`${index}-${source.label.slice(0, 16)}`}
                    className="rounded-lg px-3 py-2 leading-relaxed"
                    style={{
                      background: 'var(--secondary)',
                      color: 'var(--foreground)',
                      border: '1px solid var(--kg-node-border)',
                    }}
                  >
                    <div className="flex items-start gap-2 font-medium">
                      <span
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase"
                        style={{ background: 'var(--kg-node-bg)', color: 'var(--muted-foreground)' }}
                      >
                        {source.kind}
                      </span>
                      <span className="min-w-0">
                        {source.isLinkable && source.url ? (
                          <a href={source.url} target="_blank" rel="noreferrer" className="break-words underline underline-offset-2">
                            {source.label}
                          </a>
                        ) : source.documentNodeId ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-left underline underline-offset-2 transition-opacity hover:opacity-75"
                            onClick={() => {
                              setSelectedEvidence(null);
                              onNodeClickRef.current?.(source.documentNodeId!);
                            }}
                          >
                            <FileText size={13} strokeWidth={2} />
                            {source.label}
                          </button>
                        ) : (
                          source.label
                        )}
                      </span>
                    </div>
                    {source.snippet && source.snippet !== source.label && (
                      <div className="mt-2 max-h-24 overflow-auto rounded-md p-2 text-[11px]" style={{ color: 'var(--muted-foreground)', background: 'var(--kg-node-bg)' }}>
                        {source.snippet}
                      </div>
                    )}
                  </div>
                ))}
                {selectedEvidence.sources.length > 3 && (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-left text-xs font-medium transition-colors hover:bg-accent"
                    style={{ color: 'var(--muted-foreground)' }}
                    onClick={() => setShowAllEvidenceSources(prev => !prev)}
                  >
                    {showAllEvidenceSources ? 'Show fewer sources' : `Show ${selectedEvidence.sources.length - 3} more source${selectedEvidence.sources.length - 3 === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {selectedBucket && (
        <div
          className="absolute left-5 top-20 z-20 w-[min(340px,calc(100vw-40px))] rounded-xl p-4"
          style={{
            background: 'var(--kg-node-bg)',
            border: '1px solid var(--kg-node-border)',
            boxShadow: 'var(--kg-shadow-lg)',
            color: 'var(--foreground)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
                Grouped Area
              </div>
              <div className="mt-1 truncate text-sm font-semibold">{selectedBucket.label}</div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {selectedBucket.members.length} visible member{selectedBucket.members.length === 1 ? '' : 's'}
              </div>
            </div>
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
              title="Close group"
              onClick={() => setSelectedBucket(null)}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
              style={{ border: '1px solid var(--kg-node-border)' }}
              onClick={() => {
                const ids = selectedBucket.members.map(member => member.id);
                onFocusNodesRef.current?.(ids);
                fitSigmaToNodeIds(rendererRef.current, graphRef.current, ids);
              }}
            >
              Fit group
            </button>
          </div>
          <div className="mt-3 max-h-72 space-y-1 overflow-auto pr-1">
            {selectedBucket.members.map(member => (
              <button
                key={member.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                style={{ background: 'var(--secondary)' }}
                onClick={() => {
                  setSelectedBucket(null);
                  onNodeClickRef.current?.(member.id);
                  fitSigmaToNodeIds(rendererRef.current, graphRef.current, [member.id]);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{member.label}</span>
                  <span className="block truncate opacity-70">{member.kind}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
