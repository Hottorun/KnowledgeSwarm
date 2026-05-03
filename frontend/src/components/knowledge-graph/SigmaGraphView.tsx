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
};

type SigmaEdgeAttributes = {
  size: number;
  color: string;
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

const OVERVIEW_EDGE_LIMIT = 2500;
// Cap on how many direct spokes the central node gets. Overflow neighbors stay
// in the graph but are routed through semantic bucket nodes so the center stays
// readable without hiding useful evidence.
const MAX_LEVEL_1_FANOUT = 12;
const SIGMA_BUCKET_PREFIX = 'sigma-bucket:';

function overviewEdgeLimit(nodeCount: number): number {
  if (nodeCount > 1500) return 1600;
  if (nodeCount > 900) return 2000;
  return OVERVIEW_EDGE_LIMIT;
}

function sigmaLabelSettings(nodeCount: number, viewMode: 'focused' | 'overview'): { labelDensity: number; labelRenderedSizeThreshold: number } {
  if (viewMode === 'focused') return { labelDensity: 0.12, labelRenderedSizeThreshold: 8 };
  if (nodeCount > 1200) return { labelDensity: 0.012, labelRenderedSizeThreshold: 17 };
  if (nodeCount > 700) return { labelDensity: 0.022, labelRenderedSizeThreshold: 15 };
  if (nodeCount > 350) return { labelDensity: 0.032, labelRenderedSizeThreshold: 14 };
  return { labelDensity: 0.045, labelRenderedSizeThreshold: 12 };
}

function nodeLabel(node: GraphNode): string {
  return String((node.data as GraphNodeData).label ?? node.id);
}

function nodeKind(node: GraphNode): string {
  return String((node.data as GraphNodeData).description ?? (node.data as GraphNodeData).nodeType ?? 'Entity');
}

function nodeColor(node: GraphNode, activeNodeId?: string | null, highlightedNodes?: Set<string>): string {
  const data = node.data as GraphNodeData;
  if (node.id === activeNodeId) return '#111827';
  if (highlightedNodes?.has(node.id) || data.isHighlighted) return '#2563eb';
  if (data.isSigmaBucket) return '#4f46e5';
  const kind = nodeKind(node).toLowerCase();
  if (kind.includes('document')) return '#0284c7';
  if (kind.includes('category') || data.presentationRole === 'category') return '#7c3aed';
  if (kind.includes('person')) return '#16a34a';
  if (kind.includes('financial') || kind.includes('revenue') || kind.includes('market')) return '#ca8a04';
  if (kind.includes('risk') || kind.includes('legal') || kind.includes('contract')) return '#dc2626';
  return '#374151';
}

function nodeSize(node: GraphNode, activeNodeId?: string | null, viewMode: 'focused' | 'overview' = 'focused'): number {
  const data = node.data as GraphNodeData;
  const overviewScale = viewMode === 'overview' ? 0.62 : 1;
  if (node.id === activeNodeId || data.presentationRole === 'main_entity' || data.nodeType === 'root') return 18 * overviewScale;
  if (data.isSigmaBucket) return 11 * overviewScale;
  if (data.presentationRole === 'category' || data.nodeType === 'topic') return 12 * overviewScale;
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
  viewMode: 'focused' | 'overview' = 'focused',
): string | null {
  if (viewMode === 'focused' && activeNodeId && nodes.some(node => node.id === activeNodeId)) return activeNodeId;
  const main = nodes.find(isMainEntityNode);
  if (main) return main.id;
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

  const layoutQueue = [centerId];
  while (layoutQueue.length > 0) {
    const parentId = layoutQueue.shift()!;
    const parentPosition = positions.get(parentId);
    if (!parentPosition) continue;
    const children = sortBranchNodes(childrenByParent.get(parentId) ?? []);
    if (children.length === 0) continue;

    const childDepth = parentPosition.depth + 1;
    const isRootFanout = parentId === centerId;
    const crowdFactor = Math.min(children.length, 24);
    const spread = isRootFanout
      ? Math.PI * 2
      : Math.min(
          Math.PI * 1.45,
          Math.PI * (0.42 + crowdFactor * 0.062) / Math.max(1, childDepth * 0.42),
        );
    const baseAngle = isRootFanout ? -Math.PI / 2 : parentPosition.angle;
    const step = children.length === 1 ? 0 : spread / (children.length - 1);
    const startAngle = isRootFanout ? baseAngle : baseAngle - spread / 2;
    const distance = isRootFanout
      ? Math.max(14, children.length * 2.25)
      : Math.max(8.5, Math.sqrt(children.length) * 2.8 + childDepth * 2.7 + 2.8);

    let rootCursor = baseAngle - Math.PI;
    const rootWeights = isRootFanout
      ? children.map(child => Math.max(1, Math.sqrt(subtreeSize(child.id))))
      : [];
    const rootTotalWeight = rootWeights.reduce((sum, weight) => sum + weight, 0);

    children.forEach((child, index) => {
      const angle = (() => {
        if (!isRootFanout) return startAngle + step * index;
        const sector = (rootWeights[index] / Math.max(rootTotalWeight, 1)) * Math.PI * 2;
        const midpoint = rootCursor + sector / 2;
        rootCursor += sector;
        return midpoint;
      })();
      const branchWeight = isRootFanout ? rootWeights[index] : 1;
      const branchDistance = isRootFanout ? distance + Math.min(7, branchWeight * 0.8) : distance;
      const x = parentPosition.x + Math.cos(angle) * branchDistance;
      const y = parentPosition.y + Math.sin(angle) * branchDistance;
      positions.set(child.id, { id: child.id, x, y, depth: childDepth, angle });
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
    data.presentationRole === 'category';
  const forceLabel = viewMode === 'overview'
    ? isKeyNode && totalNodes <= 240
    : position.depth <= 1 || node.id === activeNodeId;

  return {
    x: position.x,
    y: position.y,
    label: nodeLabel(node),
    size: nodeSize(node, activeNodeId, viewMode),
    color: nodeColor(node, activeNodeId, highlightedNodes),
    forceLabel,
    zIndex: node.id === activeNodeId ? 10 : 1,
  };
}

function edgeAttributes(edge: GraphEdge, activeNodeId?: string | null, viewMode: 'focused' | 'overview' = 'focused'): SigmaEdgeAttributes {
  const activeEdge = edge.source === activeNodeId || edge.target === activeNodeId;
  return {
    size: activeEdge ? (viewMode === 'overview' ? 1.75 : 2) : (viewMode === 'overview' ? 0.6 : 1),
    color: activeEdge ? '#111827' : (viewMode === 'overview' ? '#d1d5db' : '#9ca3af'),
  };
}

function isStructuralNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  if (data.isSigmaBucket) return true;
  return data.presentationRole === 'main_entity' ||
    data.presentationRole === 'category' ||
    data.nodeType === 'root' ||
    data.nodeType === 'topic' ||
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

function level1FanoutScore(node: GraphNode, undirectedDegree: number): number {
  const data = node.data as GraphNodeData;
  const importance = typeof data.importance === 'number' ? data.importance : 0;
  let structural = 0;
  if (data.presentationRole === 'main_entity') structural += 100;
  else if (data.presentationRole === 'category' || data.nodeType === 'topic') structural += 50;
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
    if (!node) return false;
    const data = node.data as GraphNodeData;
    return data.presentationRole === 'category' || data.nodeType === 'topic';
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

export function SigmaGraphView({
  nodes,
  edges,
  activeNodeId,
  highlightedNodes,
  viewMode = 'focused',
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
  const edgeByIdRef = useRef<Map<string, GraphEdge>>(new Map());
  const nodeLabelByIdRef = useRef<Map<string, string>>(new Map());
  const documentNodeBySourceKeyRef = useRef<Map<string, string>>(new Map());
  const virtualBucketIdsRef = useRef<Set<string>>(new Set());
  const bucketMemberIdsRef = useRef<Map<string, string[]>>(new Map());
  const activeNodeIdRef = useRef(activeNodeId);
  const viewModeRef = useRef(viewMode);
  const onNodeClickRef = useRef(onNodeClick);
  const onFocusNodesRef = useRef(onFocusNodes);
  const onPaneClickRef = useRef(onPaneClick);
  const [selectedEvidence, setSelectedEvidence] = useState<EdgeEvidence | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<BucketSelection | null>(null);
  const [showAllEvidenceSources, setShowAllEvidenceSources] = useState(false);
  const [copiedEvidence, setCopiedEvidence] = useState(false);

  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onFocusNodesRef.current = onFocusNodes;
    onPaneClickRef.current = onPaneClick;
    activeNodeIdRef.current = activeNodeId;
    viewModeRef.current = viewMode;
  }, [activeNodeId, onFocusNodes, onNodeClick, onPaneClick, viewMode]);

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
        renderEdgeLabels: false,
        zIndex: true,
      });
      rendererRef.current.on('clickNode', ({ node }) => {
        setSelectedEvidence(null);
        setShowAllEvidenceSources(false);
        setCopiedEvidence(false);
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
      rendererRef.current.on('enterNode', () => {
        rendererRef.current!.getContainer().style.cursor = 'pointer';
      });
      rendererRef.current.on('leaveNode', () => {
        rendererRef.current!.getContainer().style.cursor = 'default';
      });
      rendererRef.current.on('enterEdge', ({ edge }) => {
        rendererRef.current!.getContainer().style.cursor = 'pointer';
        const graph = graphRef.current;
        if (graph?.hasEdge(edge)) {
          graph.mergeEdgeAttributes(edge, {
            size: viewModeRef.current === 'overview' ? 2.5 : 3,
            color: '#111827',
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
    }

    const graph = graphRef.current;
    const centerId = pickCenter(nodes, edges, activeNodeId, viewMode);
    const bucketed = bucketCentralFanout(nodes, edges, centerId);
    const visibleNodes = bucketed.nodes;
    const visibleEdges = bucketed.edges;
    rendererRef.current.setSettings(sigmaLabelSettings(visibleNodes.length, viewMode));
    const nodeIds = new Set(visibleNodes.map(node => node.id));
    const renderableEdges = selectRenderableEdges(visibleNodes, visibleEdges, activeNodeId, viewMode);
    const edgeIds = new Set(renderableEdges.map(edgeKey));
    const positions = computeBranchLayout(visibleNodes, renderableEdges, activeNodeId, viewMode);
    nodeLabelByIdRef.current = new Map(visibleNodes.map(node => [node.id, nodeLabel(node)]));
    documentNodeBySourceKeyRef.current = buildDocumentSourceIndex(visibleNodes);
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
      if (!nodeIds.has(String(nodeId))) nodesToDrop.push(String(nodeId));
    });
    edgesToDrop.forEach(edgeId => graph.dropEdge(edgeId));
    nodesToDrop.forEach(nodeId => graph.dropNode(nodeId));

    const addOrUpdateNode = (node: GraphNode) => {
      const position = positions.get(node.id) ?? { id: node.id, x: 0, y: 0, depth: 0, angle: 0 };
      const attrs = nodeAttributes(node, position, activeNodeId, highlightedNodes, viewMode, visibleNodes.length);
      if (!graph.hasNode(node.id)) {
        const startX = shouldAnimatePositions ? (centerPosition?.x ?? attrs.x) : attrs.x;
        const startY = shouldAnimatePositions ? (centerPosition?.y ?? attrs.y) : attrs.y;
        graph.addNode(node.id, { ...attrs, x: startX, y: startY });
        if (shouldAnimatePositions) {
          nodeTweens.push({ id: node.id, fromX: startX, fromY: startY, toX: attrs.x, toY: attrs.y });
        }
      } else {
        const current = graph.getNodeAttributes(node.id) as Partial<SigmaNodeAttributes>;
        const fromX = typeof current.x === 'number' ? current.x : attrs.x;
        const fromY = typeof current.y === 'number' ? current.y : attrs.y;
        graph.replaceNodeAttributes(node.id, shouldAnimatePositions ? { ...attrs, x: fromX, y: fromY } : attrs);
        if (shouldAnimatePositions && (Math.abs(fromX - attrs.x) > 0.01 || Math.abs(fromY - attrs.y) > 0.01)) {
          nodeTweens.push({ id: node.id, fromX, fromY, toX: attrs.x, toY: attrs.y });
        }
      }
    };

    const addOrUpdateEdge = (edge: GraphEdge, index: number) => {
      const id = edgeKey(edge, index);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) return;
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return;
      const attrs = edgeAttributes(edge, activeNodeId, viewMode);
      if (!graph.hasEdge(id)) {
        graph.addEdgeWithKey(id, edge.source, edge.target, attrs);
      } else {
        graph.replaceEdgeAttributes(id, attrs);
      }
    };

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

    const wasEmpty = previousNodeCountRef.current === 0;
    const centerChanged = previousCenterIdRef.current !== centerId;
    previousNodeCountRef.current = visibleNodes.length;
    previousCenterIdRef.current = centerId;

    if ((wasEmpty && visibleNodes.length > 0) || centerChanged) {
      void rendererRef.current.getCamera().animatedReset({ duration: wasEmpty ? 420 : 260 });
    }
  }, [nodes, edges, activeNodeId, highlightedNodes, viewMode]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer));
      timersRef.current = [];
      if (positionFrameRef.current !== null) {
        cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
      rendererRef.current?.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      <div
        className="absolute bottom-5 right-5 z-20 flex flex-col overflow-hidden rounded-xl"
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
      {selectedEvidence && (
        <div
          className="absolute left-5 bottom-5 z-20 w-[min(360px,calc(100vw-40px))] rounded-xl p-4"
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
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
              title={copiedEvidence ? 'Copied evidence' : 'Copy evidence'}
              onClick={() => {
                if (!navigator.clipboard) return;
                void navigator.clipboard.writeText(evidenceToText(selectedEvidence)).then(() => {
                  setCopiedEvidence(true);
                  window.setTimeout(() => setCopiedEvidence(false), 1400);
                });
              }}
            >
              {copiedEvidence ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
            </button>
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
                {(showAllEvidenceSources ? selectedEvidence.sources : selectedEvidence.sources.slice(0, 3)).map((source, index) => (
                  <div
                    key={`${index}-${source.label.slice(0, 16)}`}
                    className="rounded-lg px-3 py-2 leading-relaxed"
                    style={{ background: 'var(--secondary)', color: 'var(--foreground)' }}
                  >
                    <div className="font-medium">
                      <span
                        className="mr-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase"
                        style={{ background: 'var(--kg-node-bg)', color: 'var(--muted-foreground)' }}
                      >
                        {source.kind}
                      </span>
                      {source.isLinkable && source.url ? (
                        <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
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
                    </div>
                    {source.snippet && source.snippet !== source.label && (
                      <div className="mt-1" style={{ color: 'var(--muted-foreground)' }}>
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
