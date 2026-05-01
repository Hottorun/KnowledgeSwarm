import { useCallback, useState, useMemo, useEffect, useRef, useDeferredValue } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useOnViewportChange,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AnimatePresence, motion } from 'framer-motion';

import { AnimatedBlob, LoadingBlob } from './AnimatedBlob';
import { GraphNodeMemo, calcNodeDims, type GraphNodeData } from './GraphNode';
import { GraphSearchPanel } from './GraphSearchPanel';
import { NodeInputBox } from './NodeInputBox';
import { SidePanel } from './SidePanel';
import { TopNav } from './TopNav';
import { EdgeButton } from './EdgeButton';
import { FloatingEdge } from './FloatingEdge';
import type { AIReasoningStep, DataSource } from './types';
import type { NodeRelationship } from './NodeInputBox';
import { createRun, extractFromText, openRunStream, expandSubtree as apiExpandSubtree, queryGraph as apiQueryGraph, categorizeNodes, type ExpandContext, type NodeCategory } from '@/lib/api';
import { extractFileText } from '@/lib/pdf';
import { QueryBox } from './QueryBox';

type GraphLayoutNode = Node<GraphNodeData>;

// ── Force-directed layout ─────────────────────────────────────────────────────

function forceDirectedLayout(
  layoutNodes: GraphLayoutNode[],
  layoutEdges: Edge[],
  manualPins: Set<string> = new Set(),
): GraphLayoutNode[] {
  if (layoutNodes.length === 0) return layoutNodes;

  const REPULSION = 28000;
  const IDEAL_LENGTH = 320;
  const STIFFNESS = 0.07;
  const DAMPING = 0.80;
  const ITERATIONS = 450;

  const pos = new Map<string, { x: number; y: number }>(
    layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }])
  );
  const vel = new Map<string, { x: number; y: number }>(
    layoutNodes.map(n => [n.id, { x: 0, y: 0 }])
  );
  const pinned = new Set(
    layoutNodes
      .filter(n => (n.data as GraphNodeData).nodeType === 'root' || manualPins.has(n.id))
      .map(n => n.id),
  );

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = new Map<string, { x: number; y: number }>(
      layoutNodes.map(n => [n.id, { x: 0, y: 0 }])
    );

    // Coulomb repulsion between every pair
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

    // Hooke spring attraction along each edge
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

    // Semi-implicit Euler integration with damping
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

// ── Overlap resolver ──────────────────────────────────────────────────────────

const NODE_GAP = 20;

// Returns the actual rendered dimensions for a node, matching calcNodeDims in GraphNode.tsx.
// We pass hasAccent=true so wide entity-type badges are included in the width estimate.
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

  // Overshoot factor: push apart slightly more than the bare overlap so the
  // iterative solver converges in fewer passes instead of oscillating at the boundary.
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
        const aCenterX = pa.x + da.w / 2, aCenterY = pa.y + da.h / 2;
        const bCenterX = pb.x + db.w / 2, bCenterY = pb.y + db.h / 2;

        if (overlapX <= overlapY) {
          const dir = bCenterX >= aCenterX ? 1 : -1;
          const push = overlapX * OVERSHOOT;
          const half = push / 2;
          if (!aPinned && !bPinned) { pa.x -= dir * half; pb.x += dir * half; }
          else if (aPinned)         { pb.x += dir * push; }
          else                      { pa.x -= dir * push; }
        } else {
          const dir = bCenterY >= aCenterY ? 1 : -1;
          const push = overlapY * OVERSHOOT;
          const half = push / 2;
          if (!aPinned && !bPinned) { pa.y -= dir * half; pb.y += dir * half; }
          else if (aPinned)         { pb.y += dir * push; }
          else                      { pa.y -= dir * push; }
        }
      }
    }

    if (!anyOverlap) break;
  }

  return layoutNodes.map(n => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

function layout(
  nodes: GraphLayoutNode[],
  edges: Edge[],
  manualPins: Set<string> = new Set(),
): GraphLayoutNode[] {
  return resolveOverlaps(forceDirectedLayout(nodes, edges, manualPins), manualPins);
}

// ── SSE payload types ─────────────────────────────────────────────────────────

interface BackendNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

interface BackendEdge {
  source: string;
  target: string;
  predicate: string;
  confidence?: number;
  sources?: BackendSource[];
  properties?: Record<string, unknown>;
}

interface BackendSource {
  url: string;
  title?: string;
  snippet?: string;
}

interface SseEnvelope<T> {
  type: string;
  runId: string;
  timestamp: string;
  payload: T;
}

// ── Depth helper ──────────────────────────────────────────────────────────────

function computeNodeDepth(nodeId: string, edgeList: Edge[]): number {
  let depth = 0;
  let cursor = nodeId;
  const visited = new Set<string>();
  while (depth < 20) {
    visited.add(cursor);
    const parentEdge = edgeList.find(e => e.target === cursor && !visited.has(e.source));
    if (!parentEdge) break;
    cursor = parentEdge.source;
    depth++;
  }
  return depth;
}

// BFS from root → assign animDelay (seconds) per node/edge so center renders first.
// Stagger: stepMs = min(400, 2000 / maxDepth) — total animation ≤ 2s for deep graphs,
// up to 400ms/layer for shallow ones giving a premium 600-1200ms per-layer feel.
// Edges fire 180ms after their source node so they "draw out" from an appearing node.
function assignAnimDelays(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const rootNode = nodes.find(n => (n.data as { nodeType?: string }).nodeType === 'root');
  const depthMap = new Map<string, number>();

  if (rootNode) {
    const queue: [string, number][] = [[rootNode.id, 0]];
    const visited = new Set<string>();
    while (queue.length) {
      const item = queue.shift()!;
      const [id, depth] = item;
      if (visited.has(id)) continue;
      visited.add(id);
      depthMap.set(id, depth);
      edges.filter(e => e.source === id).forEach(e => {
        if (!visited.has(e.target)) queue.push([e.target, depth + 1]);
      });
    }
  }

  const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.values()) : 0;
  nodes.forEach(n => { if (!depthMap.has(n.id)) depthMap.set(n.id, maxDepth); });

  const effectiveMax = Math.max(...depthMap.values(), 1);
  const stepMs = Math.min(600, 3000 / effectiveMax);

  return {
    nodes: nodes.map(n => ({
      ...n,
      data: { ...n.data, animDelay: (depthMap.get(n.id) ?? 0) * stepMs / 1000 },
    })),
    edges: edges.map(e => ({
      ...e,
      data: { ...(e.data ?? {}), animDelay: (depthMap.get(e.source) ?? 0) * stepMs / 1000 + 0.18 },
    })),
  };
}

function formatSourceLabel(sources: BackendSource[]): string | undefined {
  const source = sources.find(item => item.title || item.url);
  if (!source) return undefined;
  return source.title || source.url.replace(/^local:\/\//, '');
}

function formatPredicateLabel(predicate: string): string {
  return predicate.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Component ─────────────────────────────────────────────────────────────────

function KnowledgeGraphCanvasInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isDissolving, setIsDissolving] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [inputBoxPos, setInputBoxPos] = useState<{ x: number; y: number } | null>(null);
  const [leftPanel, setLeftPanel] = useState(false);
  const [rightPanel, setRightPanel] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [connectionMode, setConnectionMode] = useState(false);
  const [, setDataSources] = useState<DataSource[]>([]);
  const [selectedNodeRelationships, setSelectedNodeRelationships] = useState<NodeRelationship[]>([]);
  const [reasoningSteps, setReasoningSteps] = useState<AIReasoningStep[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [categories, setCategories] = useState<NodeCategory[]>([]);
  const categorizationCountRef = useRef(0);
  const [isQuerying, setIsQuerying] = useState(false);
  const [queryAnswer, setQueryAnswer] = useState<string | null>(null);
  const [queryNewNodesCount, setQueryNewNodesCount] = useState(0);
  const reactFlowInstance = useReactFlow();

  const nodeTypes = useMemo(() => ({ graphNode: GraphNodeMemo }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);

  // Web Worker for off-main-thread layout
  const layoutWorkerRef = useRef<Worker | null>(null);
  const layoutWorkerIdRef = useRef(0);
  const layoutWorkerPendingRef = useRef<Map<number, (positions: Record<string, { x: number; y: number }>) => void>>(new Map());

  useEffect(() => {
    const worker = new Worker(new URL('../../workers/layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, positions } = e.data as { id: number; positions: Record<string, { x: number; y: number }> };
      const resolve = layoutWorkerPendingRef.current.get(id);
      if (resolve) {
        layoutWorkerPendingRef.current.delete(id);
        resolve(positions);
      }
    };
    layoutWorkerRef.current = worker;
    return () => { worker.terminate(); layoutWorkerRef.current = null; };
  }, []);

  const runLayoutAsync = useCallback(
    (layoutNodes: GraphLayoutNode[], layoutEdges: Edge[], manualPins: Set<string>): Promise<Record<string, { x: number; y: number }>> => {
      const worker = layoutWorkerRef.current;
      if (!worker) {
        // Synchronous fallback if worker not yet ready
        const result = layout(layoutNodes, layoutEdges, manualPins);
        const positions: Record<string, { x: number; y: number }> = {};
        for (const n of result) positions[n.id] = n.position;
        return Promise.resolve(positions);
      }
      return new Promise(resolve => {
        const id = ++layoutWorkerIdRef.current;
        layoutWorkerPendingRef.current.set(id, resolve);
        worker.postMessage({
          id,
          nodes: layoutNodes.map(n => ({ id: n.id, position: n.position, data: { nodeType: (n.data as GraphNodeData).nodeType, label: (n.data as GraphNodeData).label, description: (n.data as GraphNodeData).description } })),
          edges: layoutEdges.map(e => ({ source: e.source, target: e.target })),
          manualPins: [...manualPins],
        });
      });
    },
    [],
  );

  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [aiHighlightedNodes, setAiHighlightedNodes] = useState<Set<string>>(new Set());
  const [expandedSubtree, setExpandedSubtree] = useState<Set<string>>(new Set());
  const [pinnedExpansion, setPinnedExpansion] = useState<Set<string>>(new Set());
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const viewportDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const nodePositionRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const childCountRef = useRef<Map<string, number>>(new Map());
  const placeholderNodesRef = useRef<Set<string>>(new Set());
  const expansionAnchorRef = useRef<{ id: string; pos: { x: number; y: number } } | null>(null);
  const expansionChildIdxRef = useRef<number>(0);
  // Serialize expansions — clicking expand on a 2nd node before the 1st finishes
  // would otherwise overwrite expansionAnchorRef and route all the 1st's pending
  // SSE nodes to the 2nd's anchor.
  const expansionQueueRef = useRef<Array<() => Promise<void>>>([]);
  const expansionRunningRef = useRef<boolean>(false);
  const [queuedExpansions, setQueuedExpansions] = useState<number>(0);
  const nodesRef = useRef<Node[]>([]);
  const expansionDepthRef = useRef<number>(0);
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgesRef = useRef<Edge[]>([]);
  const isSwarmExtraction = useRef(false);
  // Set to true while a graph query is in flight so SSE nodes commit immediately
  // (no batch buffering, no fitView) — same as expansion mode but anchorless.
  const queryModeRef = useRef(false);
  // Nodes the user has manually dragged — pinned so re-layouts after expansion
  // don't snap them back to their physics-determined position.
  const userMovedRef = useRef<Set<string>>(new Set());
  // Buffers for initial-load SSE events — committed all-at-once after layout so nodes
  // never appear in unsorted positions.
  const pendingNodesRef = useRef<Map<string, GraphLayoutNode>>(new Map());
  const pendingEdgesRef = useRef<Map<string, Edge>>(new Map());
  const appendModeRef = useRef(false);
  const activeNodeIdsRef = useRef<Set<string>>(new Set());
  // Undo history — snapshots of {nodes, edges} before each expansion/deletion
  const historyRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const redoStackRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Nodes created during the CURRENT expansion task — chain edges (new node →
  // newer node) need this set to survive the anchor-scope filter in edge.created.
  const expansionNewNodesRef = useRef<Set<string>>(new Set());

  useOnViewportChange({
    onChange: useCallback((vp: { x: number; y: number; zoom: number }) => {
      setViewport(vp);
    }, []),
  });

  // Keep edgesRef in sync so the layout debounce can read current edges
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // ⌘K / Ctrl+K opens search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Sync expanding state into node data so GraphNode can render the blob animation
  useEffect(() => {
    setNodes(prev => prev.map(n => {
      const wasExpanding = (n.data as GraphNodeData).isExpanding;
      const shouldExpand = n.id === expandingNodeId;
      if (wasExpanding === shouldExpand) return n;
      return { ...n, data: { ...n.data, isExpanding: shouldExpand } };
    }));
  }, [expandingNodeId, setNodes]);

  // Expand nodes visible in the current viewport, compact those that have panned out.
  // Debounced so mid-gesture frames don't trigger unnecessary state updates.
  useEffect(() => {
    if (nodes.length <= 50) return;

    if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);

    viewportDebounceRef.current = setTimeout(() => {
      if (viewport.zoom < 0.8) {
        setExpandedSubtree(prev => (prev.size > 0 ? new Set() : prev));
        setPinnedExpansion(prev => (prev.size > 0 ? new Set() : prev));
        return;
      }
      if (viewport.zoom < 0.9) return; // hysteresis band — don't expand or collapse

      const left = (-viewport.x) / viewport.zoom;
      const top = (-viewport.y) / viewport.zoom;
      const right = left + window.innerWidth / viewport.zoom;
      const bottom = top + window.innerHeight / viewport.zoom;

      const visibleIds = new Set<string>();
      nodes.forEach(n => {
        if (
          n.position.x >= left - 200 && n.position.x <= right + 200 &&
          n.position.y >= top - 200 && n.position.y <= bottom + 200
        ) {
          visibleIds.add(n.id);
        }
      });

      setExpandedSubtree(prev => {
        if (prev.size === visibleIds.size && [...visibleIds].every(id => prev.has(id))) return prev;
        return visibleIds;
      });
    }, 120);

    return () => { if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current); };
  }, [viewport, nodes]);

  // Assign a spiral position to a new node that has no known parent yet
  const assignSpiralPosition = useCallback((nodeId: string): { x: number; y: number } => {
    const total = nodePositionRef.current.size;
    const angle = total * 137.508 * (Math.PI / 180);
    const radius = 150 + total * 60;
    const pos = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    nodePositionRef.current.set(nodeId, pos);
    placeholderNodesRef.current.add(nodeId);
    return pos;
  }, []);

  // Reposition a placeholder node relative to its newly known parent
  const assignChildPosition = useCallback((sourceId: string, targetId: string): { x: number; y: number } | null => {
    if (!placeholderNodesRef.current.has(targetId)) return null;
    const sourcePos = nodePositionRef.current.get(sourceId);
    if (!sourcePos) return null;

    const idx = childCountRef.current.get(sourceId) ?? 0;
    childCountRef.current.set(sourceId, idx + 1);
    const angle = idx * 137.508 * (Math.PI / 180);
    const radius = 200 + idx * 15;
    const pos = {
      x: sourcePos.x + Math.cos(angle) * radius,
      y: sourcePos.y + Math.sin(angle) * radius,
    };
    nodePositionRef.current.set(targetId, pos);
    placeholderNodesRef.current.delete(targetId);
    return pos;
  }, []);

  const connectRunStream = useCallback((activeRunId: string) => {
    eventSourceRef.current?.close();

    const source = openRunStream(activeRunId);
    eventSourceRef.current = source;

    source.addEventListener('node.created', (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ node: BackendNode }>;
      const backendNode = envelope.payload.node;
      const anchor = expansionAnchorRef.current;

      // dedup: also check pending buffer, not just committed nodes
      const normalLabel = backendNode.label.toLowerCase().trim();
      const existingByLabel =
        nodesRef.current.find(n => n.id !== backendNode.id && ((n.data as GraphNodeData).label ?? '').toLowerCase().trim() === normalLabel) ??
        [...pendingNodesRef.current.values()].find(n => n.id !== backendNode.id && n.data.label.toLowerCase().trim() === normalLabel);
      if (existingByLabel) {
        if (anchor) {
          // Mark the reused node as "touched" so any chain edges originating from
          // it (e.g. existing Tim Cook → age → new "63") aren't blocked by the
          // anchor-scope filter in edge.created.
          expansionNewNodesRef.current.add(existingByLabel.id);
          const reuseId = `e-reuse-${anchor.id}-${existingByLabel.id}`;
          setEdges(prev => prev.some(ex => ex.id === reuseId) ? prev : [...prev, {
            id: reuseId, source: anchor.id, target: existingByLabel.id,
            label: 'also connects', type: 'floating',
          }]);
        }
        return;
      }

      // Position new node relative to anchor (or spiral fallback)
      let pos: { x: number; y: number };
      if (anchor) {
        const idx = expansionChildIdxRef.current++;
        const angle = idx * 137.508 * (Math.PI / 180);
        const radius = 220 + idx * 20;
        pos = { x: anchor.pos.x + Math.cos(angle) * radius, y: anchor.pos.y + Math.sin(angle) * radius };
      } else {
        pos = assignSpiralPosition(backendNode.id);
      }
      nodePositionRef.current.set(backendNode.id, pos);
      placeholderNodesRef.current.add(backendNode.id);

      const parentDepth = expansionDepthRef.current;
      const nodeType: GraphNodeData['nodeType'] =
        parentDepth === 0 ? 'topic' : parentDepth === 1 ? 'subtopic' : 'detail';

      const newNode: GraphLayoutNode = {
        id: backendNode.id,
        type: 'graphNode',
        position: pos,
        data: { label: backendNode.label, nodeType, description: backendNode.type, parentId: anchor?.id },
      };
      activeNodeIdsRef.current.add(backendNode.id);

      if (anchor) {
        // Track this node so chain edges (newNode → newerNode) survive the
        // anchor-scope filter in edge.created — without this, intermediate
        // category nodes would never get their child items attached.
        expansionNewNodesRef.current.add(backendNode.id);
        // Expansion: commit immediately so the user sees progress
        setNodes(prev => prev.some(n => n.id === backendNode.id) ? prev : [...prev, newNode]);
        const bridgeEdgeId = `e-expand-${anchor.id}-${backendNode.id}`;
        setEdges(prev => prev.some(ex => ex.id === bridgeEdgeId) ? prev : [...prev, {
          id: bridgeEdgeId, source: anchor.id, target: backendNode.id,
          label: 'expands', type: 'floating',
        }]);
      } else if (queryModeRef.current) {
        // Query mode: commit immediately but no bridge edge and no fitView — the
        // debounce will re-layout existing nodes without disturbing the viewport.
        expansionNewNodesRef.current.add(backendNode.id);
        setNodes(prev => prev.some(n => n.id === backendNode.id) ? prev : [...prev, newNode]);
      } else {
        if (appendModeRef.current) {
          // Document uploads after the first graph should extend the current
          // graph in-place. Do not use the initial-load pending buffer here;
          // a later batch commit can replace the visible graph.
          setNodes(prev => prev.some(n => n.id === backendNode.id) ? prev : [...prev, newNode]);
        } else {
          // Initial load: buffer — nodes appear only after layout is done
          pendingNodesRef.current.set(backendNode.id, newNode);
        }
      }

      // Debounced commit + layout — fires after the SSE burst settles
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      layoutDebounceRef.current = setTimeout(() => {
        const isBatchMode = !expansionAnchorRef.current;

        if (isBatchMode && pendingNodesRef.current.size > 0) {
          const pNodes = [...pendingNodesRef.current.values()];
          const pEdges = [...pendingEdgesRef.current.values()];
          const hadCommittedNodes = nodesRef.current.length > 0;
          pendingNodesRef.current.clear();
          pendingEdgesRef.current.clear();

          const allEdges = [...edgesRef.current, ...pEdges];
          // Add incoming nodes invisible so they don't flash in the top-left corner
          const allInputNodes = [
            ...(nodesRef.current as GraphLayoutNode[]),
            ...pNodes.map(n => ({ ...n, style: { ...n.style, opacity: 0 } })),
          ];

          void runLayoutAsync(allInputNodes, allEdges, userMovedRef.current).then(positions => {
            // MERGE into whatever's currently in React state — never overwrite
            // from a (possibly-stale) snapshot. Two SSE bursts arriving close
            // together can spawn overlapping worker calls; if worker B's debounce
            // fired before worker A's setNodes was committed to nodesRef, B's
            // snapshot would be empty and overwrite A's results.
            setNodes(prev => {
              const existingIds = new Set(prev.map(n => n.id));
              const updated = prev.map(n =>
                positions[n.id]
                  ? { ...n, position: positions[n.id], style: { ...n.style, opacity: 1 } }
                  : n,
              );
              const additions = pNodes
                .filter(n => !existingIds.has(n.id))
                .map(n => ({
                  ...n,
                  position: positions[n.id] ?? n.position,
                  style: { ...n.style, opacity: 1 },
                })) as Node[];
              const merged = [...updated, ...additions];
              return assignAnimDelays(merged, [...edgesRef.current, ...pEdges]).nodes;
            });
            setEdges(prev => {
              const existingIds = new Set(prev.map(e => e.id));
              const additions = pEdges.filter(e => !existingIds.has(e.id));
              if (additions.length === 0) return prev;
              return [...prev, ...additions];
            });
            setIsProcessing(false);

            if (!hadCommittedNodes) {
              // Mark that an initial fit is needed; the useEffect tied to
              // deferredNodes will perform it once React Flow has actually
              // mounted/measured the new nodes (useDeferredValue can defer
              // the render past any rAF here).
              needsInitialFitRef.current = true;
            }
          });
        } else {
          // Expansion: re-layout committed nodes off the main thread.
          // Functional setState so concurrent worker callbacks never overwrite
          // each other's progress.
          const currentNodes = nodesRef.current as GraphLayoutNode[];
          const currentEdges = edgesRef.current;
          void runLayoutAsync(currentNodes, currentEdges, userMovedRef.current).then(positions => {
            setNodes(prev => prev.map(n => positions[n.id] ? { ...n, position: positions[n.id] } : n));
          });
        }
      }, 600);
    });

    source.addEventListener('edge.created', (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ edge: BackendEdge }>;
      const backendEdge = envelope.payload.edge;
      const anchor = expansionAnchorRef.current;

      const sourceInGraph =
        activeNodeIdsRef.current.has(backendEdge.source) ||
        pendingNodesRef.current.has(backendEdge.source);
      const targetInGraph =
        activeNodeIdsRef.current.has(backendEdge.target) ||
        pendingNodesRef.current.has(backendEdge.target);

      if (!sourceInGraph && !targetInGraph) return;
      // During expansion, allow edges from the anchor OR any node we just
      // created in this expansion (chain support). Reject edges that try to
      // reach into other branches (other pre-existing non-anchor nodes).
      if (
        anchor &&
        sourceInGraph &&
        backendEdge.source !== anchor.id &&
        !expansionNewNodesRef.current.has(backendEdge.source)
      ) return;

      // Reposition a placeholder target now that its real source is known
      const newPos = assignChildPosition(backendEdge.source, backendEdge.target);
      if (newPos) {
        if (anchor) {
          setNodes(prev => prev.map(n => n.id === backendEdge.target ? { ...n, position: newPos } : n));
        } else {
          const pending = pendingNodesRef.current.get(backendEdge.target);
          if (pending) pendingNodesRef.current.set(backendEdge.target, { ...pending, position: newPos });
        }
      }

      const edgeSource = sourceInGraph ? backendEdge.source : (anchor?.id ?? backendEdge.source);
      const edgeId = `${edgeSource}:${backendEdge.predicate}:${backendEdge.target}`;
      const edgeData = {
        confidence: backendEdge.confidence,
        sources: backendEdge.sources ?? [],
        sourceLabel: formatSourceLabel(backendEdge.sources ?? []),
      };

      if (anchor) {
        setEdges(prev => {
          if (prev.some(edge => edge.id === edgeId)) return prev;
          // Drop the placeholder bridge for this target whenever ANY real edge
          // arrives — including chain edges from a newly-created intermediate.
          // Otherwise items like "Microsoft" end up with two parents:
          //   anchor --[expands]--> Microsoft  (placeholder)
          //   "Similar Companies" --[includes]--> Microsoft  (real chain)
          const filtered = prev.filter(ex => ex.id !== `e-expand-${anchor.id}-${backendEdge.target}`);
          return [...filtered, {
            id: edgeId, source: edgeSource, target: backendEdge.target,
            label: backendEdge.predicate, type: 'floating',
            data: edgeData,
          }];
        });
      } else if (appendModeRef.current) {
        setEdges(prev => {
          if (prev.some(edge => edge.id === edgeId)) return prev;
          return [...prev, {
            id: edgeId, source: edgeSource, target: backendEdge.target,
            label: backendEdge.predicate, type: 'floating',
            data: edgeData,
          }];
        });
      } else if (queryModeRef.current) {
        // Query mode: commit edges immediately like expansion, no buffering
        setEdges(prev => {
          if (prev.some(edge => edge.id === edgeId)) return prev;
          return [...prev, {
            id: edgeId, source: edgeSource, target: backendEdge.target,
            label: backendEdge.predicate, type: 'floating',
            data: { confidence: backendEdge.confidence },
          }];
        });
      } else {
        // Buffer edge for initial load — committed alongside nodes after layout
        if (!pendingEdgesRef.current.has(edgeId)) {
          pendingEdgesRef.current.set(edgeId, {
            id: edgeId, source: edgeSource, target: backendEdge.target,
            label: backendEdge.predicate, type: 'floating',
            data: edgeData,
          });
        }
      }
    });

    source.addEventListener('source.created', (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ edge?: Pick<BackendEdge, 'source' | 'target' | 'predicate'>; source: BackendSource }>;
      const edge = envelope.payload.edge;
      if (!edge) return;

      const edgeId = `${edge.source}:${edge.predicate}:${edge.target}`;
      const addSource = (existing: Edge): Edge => {
        const currentSources = ((existing.data as { sources?: BackendSource[] } | undefined)?.sources ?? []);
        if (currentSources.some(source => source.url === envelope.payload.source.url && source.title === envelope.payload.source.title)) {
          return existing;
        }
        const sources = [...currentSources, envelope.payload.source];
        return {
          ...existing,
          data: {
            ...(existing.data ?? {}),
            sources,
            sourceLabel: formatSourceLabel(sources),
          },
        };
      };

      setEdges(prev => prev.map(existing => existing.id === edgeId ? addSource(existing) : existing));
      const pending = pendingEdgesRef.current.get(edgeId);
      if (pending) pendingEdgesRef.current.set(edgeId, addSource(pending));
    });

    const addReasoning = (e: MessageEvent) => {
      try {
        const envelope = JSON.parse(e.data) as SseEnvelope<{ agentName?: string; eventType?: string; message?: string; status?: string }>;
        const payload = envelope.payload;
        const eventType = payload.eventType ?? payload.status ?? envelope.type;
        const agentName = payload.agentName ?? '';
        if (agentName.includes('Agent') || agentName.includes('Supervisor') || agentName === 'MetaAgent') {
          isSwarmExtraction.current = true;
        }
        setReasoningSteps(prev => [...prev, {
          id: `r-${Date.now()}-${prev.length}`,
          text: payload.message ?? `[${agentName || 'System'}] ${eventType}`,
          timestamp: new Date(envelope.timestamp || Date.now()),
          type: eventType.includes('expand') ? 'expansion' : eventType.includes('connect') ? 'connection' : 'analysis',
        }]);
      } catch (err) {
        console.warn('[SSE] Failed to parse event:', err);
      }
    };

    source.addEventListener('agent.step', addReasoning);
    source.addEventListener('run.status', addReasoning);
  }, [assignSpiralPosition, assignChildPosition, setNodes, setEdges, runLayoutAsync]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      pendingNodesRef.current.clear();
      pendingEdgesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
    activeNodeIdsRef.current = new Set(nodes.map(node => node.id));
  }, [nodes]);

  const handleDataSubmit = useCallback(async (text: string, documentName = 'input.txt') => {
    setIsDissolving(true);
    setIsProcessing(true);
    expansionAnchorRef.current = null;
    expansionChildIdxRef.current = 0;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    nodePositionRef.current.clear();
    childCountRef.current.clear();
    placeholderNodesRef.current.clear();
    pendingNodesRef.current.clear();
    pendingEdgesRef.current.clear();
    userMovedRef.current.clear();
    expansionQueueRef.current.length = 0;
    expansionRunningRef.current = false;
    setQueuedExpansions(0);
    historyRef.current = [];
    redoStackRef.current = [];
    expansionNewNodesRef.current.clear();
    setCanUndo(false);
    setCanRedo(false);
    setNodes([]);
    setEdges([]);
    setReasoningSteps([]);
    setAiHighlightedNodes(new Set());
    isSwarmExtraction.current = false;

    setDataSources(prev => [...prev, {
      id: `ds-${Date.now()}`,
      name: documentName === 'input.txt' ? text.slice(0, 40) + (text.length > 40 ? '...' : '') : documentName,
      type: 'text',
      addedAt: new Date(),
    }]);

    try {
      // Use the document name (or a short excerpt) as the run topic — never the
      // full document text, which gets stored as the root context and injected
      // into every extraction system prompt, blowing the token limit.
      const runTopic = (documentName && documentName !== 'input.txt')
        ? documentName.replace(/\.[^/.]+$/, '')
        : text.slice(0, 80).trim();
      const activeRunId = await createRun(runTopic);
      setRunId(activeRunId);
      connectRunStream(activeRunId);
      setIsEmpty(false);
      await extractFromText(activeRunId, text, documentName);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backend extraction failed';
      console.error(message, error);
      setIsProcessing(false);
      setReasoningSteps(prev => [...prev, {
        id: `error-${Date.now()}`,
        text: message,
        timestamp: new Date(),
        type: 'analysis',
      }]);
    } finally {
      setIsDissolving(false);
    }
  }, [connectRunStream, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    // Re-focus the neighborhood on this node; re-cluster everything else.
    setActiveNodeId(node.id);
    setShowAllNodes(false);
    needsInitialFitRef.current = true;
    setSelectedNode(node);

    const childIds = new Set(
      (() => {
        const ids: string[] = [];
        const queue = [node.id];
        while (queue.length) {
          const current = queue.shift()!;
          edges.filter(e => e.source === current).forEach(e => {
            if (!ids.includes(e.target)) {
              ids.push(e.target);
              queue.push(e.target);
            }
          });
        }
        return ids;
      })()
    );
    setHighlightedNodes(childIds);

    const rels: NodeRelationship[] = edges
      .filter(e => e.source === node.id || e.target === node.id)
      .slice(0, 4)
      .map(e => {
        const predicate = (typeof e.label === 'string' && e.label && e.label !== 'expands')
          ? formatPredicateLabel(e.label)
          : (e.data as { predicate?: string })?.predicate ?? 'relates to';
        const sources = ((e.data as { sources?: BackendSource[] } | undefined)?.sources ?? []);
        if (e.source === node.id) {
          const other = nodes.find(n => n.id === e.target);
          return { direction: 'out' as const, predicate, otherLabel: (other?.data as GraphNodeData)?.label ?? e.target, sources };
        } else {
          const other = nodes.find(n => n.id === e.source);
          return { direction: 'in' as const, predicate, otherLabel: (other?.data as GraphNodeData)?.label ?? e.source, sources };
        }
      });
    setSelectedNodeRelationships(rels);

    // Pin the popup to the left-middle of the screen so it never overlaps
    // the focused node (which may now be re-positioned anywhere) and never
    // gets covered by neighbor nodes flowing in around the focal point.
    const boxHeight = 180;
    setInputBoxPos({ x: 24, y: window.innerHeight / 2 - boxHeight / 2 });
  }, [edges, nodes]);

  const handleNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    if (selectedNode && node.id === selectedNode.id) {
      setSelectedNode(null);
      setInputBoxPos(null);
    }
  }, [selectedNode]);

  const handleNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    // Pin the dragged node so future re-layouts don't move it
    userMovedRef.current.add(node.id);
    nodePositionRef.current.set(node.id, { x: node.position.x, y: node.position.y });
  }, []);

  const pushHistory = useCallback(() => {
    historyRef.current = [
      { nodes: [...nodesRef.current], edges: [...edgesRef.current] },
      ...historyRef.current,
    ].slice(0, 20);
    setCanUndo(true);
    // Any new mutation invalidates the redo stack
    redoStackRef.current = [];
    setCanRedo(false);
  }, []);

  const handleUndo = useCallback(() => {
    const prev = historyRef.current.shift();
    if (!prev) return;
    redoStackRef.current = [
      { nodes: [...nodesRef.current], edges: [...edgesRef.current] },
      ...redoStackRef.current,
    ].slice(0, 20);
    setCanRedo(true);
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setCanUndo(historyRef.current.length > 0);
    setSelectedNode(null);
    setInputBoxPos(null);
  }, [setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.shift();
    if (!next) return;
    historyRef.current = [
      { nodes: [...nodesRef.current], edges: [...edgesRef.current] },
      ...historyRef.current,
    ].slice(0, 20);
    setCanUndo(true);
    setNodes(next.nodes);
    setEdges(next.edges);
    setCanRedo(redoStackRef.current.length > 0);
    setSelectedNode(null);
    setInputBoxPos(null);
  }, [setNodes, setEdges]);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNode) return;
    const nodeId = selectedNode.id;
    // Collect the node + entire descendant subtree
    const toDelete = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const current = queue.shift()!;
      edgesRef.current.filter(e => e.source === current).forEach(e => {
        if (!toDelete.has(e.target)) {
          toDelete.add(e.target);
          queue.push(e.target);
        }
      });
    }
    pushHistory();
    toDelete.forEach(id => {
      userMovedRef.current.delete(id);
      nodePositionRef.current.delete(id);
    });
    setNodes(prev => prev.filter(n => !toDelete.has(n.id)));
    setEdges(prev => prev.filter(e => !toDelete.has(e.source) && !toDelete.has(e.target)));
    setSelectedNode(null);
    setInputBoxPos(null);
  }, [selectedNode, pushHistory, setNodes, setEdges]);

  // Ctrl/Cmd+Z → undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z → redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo]);

  const handleNodeAction = useCallback(async (action: string, prompt: string) => {
    if (!selectedNode) return;

    const nodeData = selectedNode.data as GraphNodeData;
    // Snapshot at click-time — these are what the queued task will use, not whatever
    // the graph looks like by the time the queue gets to it.
    const clickedNodeSnapshot = selectedNode;
    const selectedNodeId = clickedNodeSnapshot.id;
    const selectedNodePos = { ...clickedNodeSnapshot.position };
    const childIdxAtClick = edges.filter(e => e.source === selectedNodeId).length;
    const depthAtClick = computeNodeDepth(selectedNodeId, edges);

    setSelectedNode(null);
    setInputBoxPos(null);

    if (!runId) {
      setReasoningSteps(prev => [...prev, {
        id: `error-${Date.now()}`,
        text: 'Start a backend graph run before expanding nodes.',
        timestamp: new Date(),
        type: 'analysis',
      }]);
      return;
    }

    // ── Collect subtree going DOWN (children of selected node) ──────────────
    const subtreeIds = new Set<string>([selectedNodeId]);
    const downQueue = [selectedNodeId];
    while (downQueue.length) {
      const current = downQueue.shift()!;
      edges.filter(e => e.source === current).forEach(e => {
        if (!subtreeIds.has(e.target)) {
          subtreeIds.add(e.target);
          downQueue.push(e.target);
        }
      });
    }

    const subtreeNodes = nodes.filter(n => subtreeIds.has(n.id));
    const subtreeEdges = edges.filter(e => subtreeIds.has(e.source) && subtreeIds.has(e.target));

    // ── Collect ancestors going UP (parent chain to root) ────────────────────
    const ancestorIds = new Set<string>();
    const upQueue = [selectedNodeId];
    while (upQueue.length) {
      const current = upQueue.shift()!;
      edges
        .filter(e => e.target === current && !subtreeIds.has(e.source))
        .forEach(e => {
          if (!ancestorIds.has(e.source)) {
            ancestorIds.add(e.source);
            upQueue.push(e.source);
          }
        });
    }

    const ancestorNodes = nodes.filter(n => ancestorIds.has(n.id));
    const ancestorEdges = edges.filter(e =>
      (ancestorIds.has(e.source) && (ancestorIds.has(e.target) || e.target === selectedNodeId)) ||
      (ancestorIds.has(e.target) && ancestorIds.has(e.source))
    );

    // ── Build breadcrumb path for question context ───────────────────────────
    const breadcrumb: string[] = [];
    let cursor = selectedNodeId;
    const visited = new Set<string>();
    while (true) {
      visited.add(cursor);
      const parentEdge = edges.find(e => e.target === cursor && ancestorIds.has(e.source) && !visited.has(e.source));
      if (!parentEdge) break;
      const parentNode = nodes.find(n => n.id === parentEdge.source);
      if (!parentNode) break;
      breadcrumb.unshift((parentNode.data as GraphNodeData).label);
      cursor = parentEdge.source;
    }
    breadcrumb.push(nodeData.label);
    const contextPath = breadcrumb.join(' › ');

    const rootNode = {
      id: selectedNodeId,
      label: nodeData.label,
      type: nodeData.description ?? 'Entity',
    };

    const getLabel = (id: string) => (nodes.find(n => n.id === id)?.data as GraphNodeData)?.label ?? id;
    const getPredicate = (e: Edge) =>
      (typeof e.label === 'string' && e.label ? e.label : (e.data as { predicate?: string })?.predicate) ?? 'related_to';

    const contextNodes = [
      ...subtreeNodes.filter(n => n.id !== selectedNodeId),
      ...ancestorNodes,
    ].map(n => ({
      id: n.id,
      label: (n.data as GraphNodeData).label,
      type: (n.data as GraphNodeData).description ?? 'Entity',
    }));

    const contextEdges = [
      ...subtreeEdges,
      ...ancestorEdges,
    ].map(e => ({
      subjectLabel: getLabel(e.source),
      predicate: getPredicate(e),
      objectLabel: getLabel(e.target),
    }));

    // ── Resolve parent node (direct parent of the clicked node) ────────────────
    const parentEdge = edges.find(e => e.target === selectedNodeId && ancestorIds.has(e.source));
    const parentNodeInGraph = parentEdge ? nodes.find(n => n.id === parentEdge.source) : null;
    const parentNodePayload = parentNodeInGraph
      ? {
          id: parentNodeInGraph.id,
          label: (parentNodeInGraph.data as GraphNodeData).label,
          type: (parentNodeInGraph.data as GraphNodeData).description ?? 'Entity',
        }
      : undefined;

    // ── Siblings: other children of the same parent (excludes selected node) ───
    const siblingLabels = parentEdge
      ? edges
          .filter(e => e.source === parentEdge.source && e.target !== selectedNodeId)
          .map(e => {
            const sibling = nodes.find(n => n.id === e.target);
            return sibling ? (sibling.data as GraphNodeData).label : null;
          })
          .filter((l): l is string => l !== null)
      : [];

    // ── Global branches: Level-1 nodes (direct children of the graph root) ─────
    const rootNodeInGraph = nodes.find(n => (n.data as GraphNodeData).nodeType === 'root');
    const globalBranches = rootNodeInGraph
      ? edges
          .filter(e => e.source === rootNodeInGraph.id)
          .map(e => {
            const branch = nodes.find(n => n.id === e.target);
            return branch ? (branch.data as GraphNodeData).label : null;
          })
          .filter((l): l is string => l !== null)
      : [];

    const graphDepth = expansionDepthRef.current;

    const expandCtx: ExpandContext = {
      parentNode: parentNodePayload,
      siblings: siblingLabels,
      graphDepth,
      globalBranches,
    };

    const label = nodeData.label;
    const entityType = nodeData.description ?? '';
    const rootLabel = rootNodeInGraph ? (rootNodeInGraph.data as GraphNodeData).label : null;
    const rootContext = rootLabel && rootLabel !== label ? ` Frame the answer specifically in the context of "${rootLabel}".` : '';
    const pathContext = breadcrumb.length > 1 ? ` (context path: ${contextPath})` : '';

    // "Details" should answer "what is this / who is this" with attributes that
    // make sense for the entity type — biographical for People, key facts for
    // Companies, etc — always framed in context of the root.
    const detailHints: Record<string, string> = {
      Person:     `who is this — biographical and contextual info: full name, age or birth year, birthplace, education, current role, key achievements, notable affiliations`,
      Company:    `what is this — key facts: founding year, headquarters, sector, revenue/size, key products, leadership, market position`,
      Product:    `what is this — specs and key facts: release date, manufacturer, price, key features, target users, generation/version`,
      Market:     `what is this — size, growth rate, key players, major segments, recent trends`,
      Technology: `what is this — concise definition, key applications, history, major implementations, current state of the art`,
      Location:   `what is this — type (city/country/region), population, significance, notable features`,
      Document:   `what is this — author, publication date, type, main subject, key claims`,
      Concept:    `what is this — definition, origin, key proponents, main applications`,
    };
    const detailsHint = detailHints[entityType] || `key facts and attributes about what this is`;

    const defaultQuestions: Record<string, string> = {
      categories: `Generate 5 broad sub-categories of "${label}"${pathContext}. Stay abstract — no specific facts, numbers, dates, or individual names. Categories only.`,
      details:    `${detailsHint} for "${label}"${pathContext}.${rootContext}`,
    };

    const question = prompt
      ? `${prompt} — specifically about "${label}"${pathContext}`
      : defaultQuestions[action] ?? defaultQuestions.categories;

    setReasoningSteps(prev => [...prev, {
      id: `r-${Date.now()}`,
      text: `Queued "${nodeData.label}" (Level ${graphDepth})${parentNodePayload ? ` under "${parentNodePayload.label}"` : ''}…`,
      timestamp: new Date(),
      type: 'expansion',
    }]);

    // Build the expansion task — runs in the queue, sets the anchor, fires the
    // request, and waits for SSE settle before yielding to the next task.
    const task = async () => {
      expansionAnchorRef.current = { id: selectedNodeId, pos: selectedNodePos };
      expansionChildIdxRef.current = childIdxAtClick;
      expansionDepthRef.current = depthAtClick;
      // Reset the per-task new-nodes set so chain-edge filter starts clean
      expansionNewNodesRef.current = new Set();
      // Snapshot before any expansion mutates state so the user can undo it
      pushHistory();
      setExpandingNodeId(selectedNodeId);

      try {
        const result = await apiExpandSubtree(runId, rootNode, contextNodes, contextEdges, question, expandCtx);
        // POST returns once backend has emitted all SSE events. Give the frontend
        // 700ms to drain its layout-debounce buffer before the next task swaps anchors.
        await new Promise(r => setTimeout(r, 700));
        // Highlight newly added nodes so the user can spot what changed
        if (expansionNewNodesRef.current.size > 0) {
          setAiHighlightedNodes(new Set(expansionNewNodesRef.current));
        }
        setReasoningSteps(prev => [...prev, {
          id: `r-${Date.now()}-done`,
          text: `"${nodeData.label}" expanded: ${result.newTriplesPersisted} new relationship(s). ${result.summary}`,
          timestamp: new Date(),
          type: 'expansion',
        }]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error('[KnowledgeGraph] Expansion failed:', msg);
        setReasoningSteps(prev => [...prev, {
          id: `r-${Date.now()}-err`,
          text: `Expansion failed: ${msg}`,
          timestamp: new Date(),
          type: 'analysis',
        }]);
      } finally {
        // Clear anchor so the next task starts clean (or initial-load events
        // route to the buffered path instead of trying to attach to this node).
        expansionAnchorRef.current = null;
        setExpandingNodeId(null);
      }
    };

    expansionQueueRef.current.push(task);
    setQueuedExpansions(expansionQueueRef.current.length + (expansionRunningRef.current ? 1 : 0));

    if (expansionRunningRef.current) return;
    expansionRunningRef.current = true;
    while (expansionQueueRef.current.length > 0) {
      const next = expansionQueueRef.current.shift()!;
      setQueuedExpansions(expansionQueueRef.current.length + 1);
      await next();
    }
    expansionRunningRef.current = false;
    setQueuedExpansions(0);
  }, [selectedNode, runId, nodes, edges, setNodes, setEdges, pushHistory, setExpandingNodeId]);

  const handleNodeFocus = useCallback((nodeId: string) => {
    setActiveNodeId(nodeId);
    needsInitialFitRef.current = true;
    const node = nodes.find(n => n.id === nodeId);
    if (node && reactFlowInstance) {
      const ids = new Set<string>([nodeId]);
      const children = edges.filter(e => e.source === nodeId).map(e => e.target);
      children.forEach(cid => ids.add(cid));
      children.forEach(cid => {
        edges.filter(e => e.source === cid).forEach(e => ids.add(e.target));
      });

      const allDescendants = new Set<string>([nodeId]);
      const queue = [nodeId];
      while (queue.length) {
        const current = queue.shift()!;
        edges.filter(e => e.source === current).forEach(e => {
          if (!allDescendants.has(e.target)) {
            allDescendants.add(e.target);
            queue.push(e.target);
          }
        });
      }

      const relevantNodes = nodes.filter(n => ids.has(n.id));
      if (relevantNodes.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        relevantNodes.forEach(n => {
          minX = Math.min(minX, n.position.x - 120);
          minY = Math.min(minY, n.position.y - 60);
          maxX = Math.max(maxX, n.position.x + 240);
          maxY = Math.max(maxY, n.position.y + 100);
        });

        // Pin the expansion so viewport-change logic can't override it
        setExpandedSubtree(allDescendants);
        setPinnedExpansion(allDescendants);
        setTimeout(() => {
          reactFlowInstance.fitBounds(
            { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
            { padding: 0.3, duration: 600 }
          );
        }, 50);
      } else {
        setExpandedSubtree(allDescendants);
        setPinnedExpansion(allDescendants);
      }
    }
  }, [nodes, edges, reactFlowInstance]);

  const handleFocusMultiple = useCallback((nodeIds: string[]) => {
    if (!reactFlowInstance || nodeIds.length === 0) return;
    const targets = nodes.filter(n => nodeIds.includes(n.id));
    if (targets.length === 0) return;
    const ids = new Set(nodeIds);
    setHighlightedNodes(ids);
    setExpandedSubtree(ids);
    setPinnedExpansion(ids);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    targets.forEach(n => {
      minX = Math.min(minX, n.position.x - 120);
      minY = Math.min(minY, n.position.y - 60);
      maxX = Math.max(maxX, n.position.x + 240);
      maxY = Math.max(maxY, n.position.y + 100);
    });
    setTimeout(() => {
      reactFlowInstance.fitBounds(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        { padding: 0.35, duration: 700 }
      );
    }, 50);
  }, [nodes, reactFlowInstance]);

  const handleUploadDocuments = useCallback(async (files: File[]) => {
    if (!runId) return;
    if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
      connectRunStream(runId);
    }

    appendModeRef.current = true;
    pendingNodesRef.current.clear();
    pendingEdgesRef.current.clear();
    setIsProcessing(true);
    setReasoningSteps(prev => [...prev, {
      id: `upload-${Date.now()}`,
      text: `Adding ${files.length} document${files.length === 1 ? '' : 's'} to the current graph`,
      timestamp: new Date(),
      type: 'analysis',
    }]);

    for (const file of files) {
      setDataSources(prev => [...prev, {
        id: `ds-${Date.now()}-${file.name}`,
        name: file.name,
        type: 'file',
        addedAt: new Date(),
      }]);

      try {
        const text = await extractFileText(file);
        await extractFromText(runId, text, file.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to extract ${file.name}`;
        console.error(message, error);
        setReasoningSteps(prev => [...prev, {
          id: `upload-error-${Date.now()}-${file.name}`,
          text: `${file.name}: ${message}`,
          timestamp: new Date(),
          type: 'analysis',
        }]);
      }
    }
    setIsProcessing(false);
    window.setTimeout(() => {
      appendModeRef.current = false;
    }, 1000);
  }, [connectRunStream, runId]);

  // Re-categorize nodes 2s after graph settles (initial load or after expansion)
  useEffect(() => {
    if (isProcessing || nodes.length < 3) return;
    const nodeCount = nodes.length;
    if (nodeCount === categorizationCountRef.current) return;
    const timer = setTimeout(() => {
      categorizationCountRef.current = nodeCount;
      const nodeList = nodes.map(n => ({
        id: n.id,
        label: (n.data as GraphNodeData).label,
        type: (n.data as GraphNodeData).description ?? 'Entity',
      }));
      categorizeNodes(nodeList).then(cats => {
        if (cats.length > 0) setCategories(cats);
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [isProcessing, nodes]);

  const handleQuery = useCallback(async (question: string) => {
    if (!runId || isQuerying) return;

    setIsQuerying(true);
    setQueryAnswer(null);
    setQueryNewNodesCount(0);

    setReasoningSteps(prev => [...prev, {
      id: `q-${Date.now()}`,
      text: `Query: "${question}"`,
      timestamp: new Date(),
      type: 'analysis',
    }]);

    // Snapshot node/edge context for the query
    const queryNodes = nodesRef.current.map(n => ({
      id: n.id,
      label: (n.data as GraphNodeData).label,
      type: (n.data as GraphNodeData).description ?? 'Entity',
    }));
    const queryEdges = edgesRef.current
      .filter(e => typeof e.label === 'string' && e.label && e.label !== 'expands')
      .map(e => ({
        subjectLabel: (nodesRef.current.find(n => n.id === e.source)?.data as GraphNodeData)?.label ?? e.source,
        predicate: typeof e.label === 'string' ? e.label : (e.data as { predicate?: string })?.predicate ?? 'related_to',
        objectLabel: (nodesRef.current.find(n => n.id === e.target)?.data as GraphNodeData)?.label ?? e.target,
      }));

    // Track node count before query so we can report how many were added
    const nodeCountBefore = nodesRef.current.length;
    const preQueryNodeIds = new Set(nodesRef.current.map(n => n.id));

    // Flag SSE handler to commit query nodes immediately (not via batch layout)
    queryModeRef.current = true;

    try {
      const result = await apiQueryGraph(runId, question, queryNodes, queryEdges);
      setQueryAnswer(result.answer);

      // Wait for SSE debounce to flush new nodes, then compute delta
      await new Promise(r => setTimeout(r, 900));
      const added = nodesRef.current.length - nodeCountBefore;
      setQueryNewNodesCount(Math.max(0, added));
      // Highlight nodes that didn't exist before this query
      const newQueryNodeIds = new Set(nodesRef.current.filter(n => !preQueryNodeIds.has(n.id)).map(n => n.id));
      if (newQueryNodeIds.size > 0) {
        setAiHighlightedNodes(newQueryNodeIds);
      }

      if (result.newTriplesPersisted > 0) {
        setReasoningSteps(prev => [...prev, {
          id: `q-done-${Date.now()}`,
          text: `Query complete: ${result.newTriplesPersisted} new connection(s) added to graph.`,
          timestamp: new Date(),
          type: 'expansion',
        }]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Query failed';
      setQueryAnswer(`Sorry, I couldn't complete that query: ${msg}`);
      setReasoningSteps(prev => [...prev, {
        id: `q-err-${Date.now()}`,
        text: `Query error: ${msg}`,
        timestamp: new Date(),
        type: 'analysis',
      }]);
    } finally {
      queryModeRef.current = false;
      setIsQuerying(false);
    }
  }, [runId, isQuerying, setReasoningSteps]);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setInputBoxPos(null);
    setHighlightedNodes(new Set());
    setAiHighlightedNodes(new Set());
    setExpandedSubtree(new Set());
    setLeftPanel(false);
    // Clicking empty pane re-clusters: drop back to neighborhood + cluster bubble
    setShowAllNodes(false);
  }, []);

  const nodesWithHighlight = useMemo(() => {
    const isCompact = nodes.length > 50;
    const childCount = new Map<string, number>();
    if (isCompact) {
      edges.forEach(e => childCount.set(e.source, (childCount.get(e.source) || 0) + 1));
    }
    const expanded = pinnedExpansion.size > 0
      ? new Set([...expandedSubtree, ...pinnedExpansion])
      : expandedSubtree;
    return nodes.map(n => ({
      ...n,
      zIndex: expanded.has(n.id) ? 10 : 0,
      data: {
        ...n.data,
        isHighlighted: highlightedNodes.has(n.id) || aiHighlightedNodes.has(n.id),
        compact: isCompact && (n.data as GraphNodeData).nodeType !== 'root' && (childCount.get(n.id) || 0) < 3 && !expanded.has(n.id),
      },
    }));
  }, [nodes, edges, highlightedNodes, aiHighlightedNodes, expandedSubtree, pinnedExpansion]);

  // Neighborhood rendering: only mount the active node + its 1-hop neighbors.
  // Each rendered node carries a `hiddenCount` badge showing how many of its
  // OWN neighbors are off-canvas, so the user can see where more graph hangs.
  // showAllNodes toggles to the full view (e.g. via search panel).
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [showAllNodes, setShowAllNodes] = useState(false);

  // Auto-focus the first node that arrives — try root first, else fall back
  // to whichever node landed first (SSE nodes never carry nodeType='root').
  useEffect(() => {
    if (activeNodeId !== null || nodes.length === 0) return;
    const root = nodes.find(n => (n.data as GraphNodeData).nodeType === 'root');
    setActiveNodeId((root ?? nodes[0]).id);
  }, [activeNodeId, nodes]);

  useEffect(() => {
    if (activeNodeId && !nodes.some(n => n.id === activeNodeId)) {
      setActiveNodeId(nodes[0]?.id ?? null);
    }
  }, [activeNodeId, nodes]);

  const neighborhoodIds = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const ids = new Set<string>([activeNodeId]);
    for (const e of edges) {
      if (e.source === activeNodeId) ids.add(e.target);
      else if (e.target === activeNodeId) ids.add(e.source);
    }
    return ids;
  }, [activeNodeId, edges]);

  // Adjacency map for fast hidden-count computation
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [edges]);

  const visibleNodes = useMemo<Node[]>(() => {
    if (nodesWithHighlight.length === 0) return nodesWithHighlight;
    const candidates = showAllNodes
      ? nodesWithHighlight
      : nodesWithHighlight.filter(n => neighborhoodIds.has(n.id));
    const visibleIds = new Set(candidates.map(n => n.id));
    return candidates.map(n => {
      const allNeighbors = adjacency.get(n.id);
      let hidden = 0;
      if (allNeighbors) {
        for (const id of allNeighbors) if (!visibleIds.has(id)) hidden++;
      }
      return { ...n, data: { ...n.data, hiddenCount: hidden } };
    });
  }, [showAllNodes, nodesWithHighlight, neighborhoodIds, adjacency]);

  const visibleEdges = useMemo(() => {
    if (showAllNodes) return edges;
    if (!activeNodeId) return [];
    const visibleIds = neighborhoodIds;
    return edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  }, [showAllNodes, edges, activeNodeId, neighborhoodIds]);

  // Defer the (already-filtered, small) array passed to React Flow so React
  // can interrupt the paint to keep the UI responsive during rapid navigation.
  const deferredNodes = useDeferredValue(visibleNodes);
  const deferredEdges = useDeferredValue(visibleEdges);

  // Initial fitView must run AFTER React Flow has actually mounted+measured the
  // deferred nodes — calling fitView from inside the layout debounce or rAF
  // races the deferred render and ends up zooming to nothing.
  const needsInitialFitRef = useRef(false);
  useEffect(() => {
    if (!needsInitialFitRef.current || deferredNodes.length === 0) return;
    needsInitialFitRef.current = false;
    // Wait two frames for React Flow internals to measure the new node DOM
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reactFlowInstance.fitView({ padding: 0.25, duration: 400, maxZoom: 1.2, minZoom: 0.05 });
      });
    });
  }, [deferredNodes, reactFlowInstance]);

  return (
    <div className="w-screen h-screen relative overflow-hidden" style={{ background: 'var(--kg-canvas)' }}>
      <TopNav
        focusMode={focusMode}
        connectionMode={connectionMode}
        onToggleFocus={() => setFocusMode(f => !f)}
        onToggleConnection={() => setConnectionMode(c => !c)}
        onSearchOpen={() => setSearchOpen(true)}
        onUploadDocuments={handleUploadDocuments}
        graphLoaded={!isEmpty}
      />

      <GraphSearchPanel
        nodes={nodes}
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onFocusNode={handleNodeFocus}
        onFocusMultiple={handleFocusMultiple}
      />

      {!isEmpty && <EdgeButton side="left" label="Contents" icon="📑" onClick={() => setLeftPanel(p => !p)} isActive={leftPanel} />}
      {!isEmpty && <EdgeButton side="right" label="Reasoning" icon="🧠" onClick={() => setRightPanel(p => !p)} isActive={rightPanel} />}

      <ReactFlow
        nodes={deferredNodes}
        edges={deferredEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        nodesDraggable
        nodesConnectable={false}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.2, minZoom: 0.05 }}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="w-full h-full"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        {!isEmpty && (
          <Controls
            showInteractive={false}
            position="bottom-right"
          />
        )}
      </ReactFlow>

      {/* Empty state blob */}
      {(isEmpty || isDissolving) && (
        <AnimatedBlob onDataSubmit={handleDataSubmit} isDissolving={isDissolving} />
      )}

      {/* Loading blob — only for the first graph build. Later uploads append in-place. */}
      <LoadingBlob isVisible={isProcessing && nodes.length === 0} reasoningSteps={reasoningSteps} />

      <AnimatePresence>
        {isProcessing && nodes.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-5 right-5 z-30 px-3 py-2 rounded-full text-xs font-medium flex items-center gap-2"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
              color: 'var(--foreground)',
            }}
          >
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
              className="inline-block w-3 h-3 rounded-full"
              style={{ borderTop: '2px solid var(--primary)', borderRight: '2px solid transparent' }}
            />
            Adding to graph
          </motion.div>
        )}
      </AnimatePresence>

      {/* Node input box */}
      <AnimatePresence>
        {selectedNode && inputBoxPos && (
          <NodeInputBox
            nodeLabel={(selectedNode.data as GraphNodeData).label}
            entityType={(selectedNode.data as GraphNodeData).description}
            relationships={selectedNodeRelationships}
            position={inputBoxPos}
            onAction={handleNodeAction}
            onClose={() => { setSelectedNode(null); setInputBoxPos(null); setSelectedNodeRelationships([]); setHighlightedNodes(new Set()); setNodes(nds => nds.map(n => ({ ...n, selected: false }))); }}
            onDelete={(selectedNode.data as GraphNodeData).nodeType !== 'root' ? handleDeleteNode : undefined}
            addedByAI={!!( selectedNode.data as Record<string, unknown>).parentId}
          />
        )}
      </AnimatePresence>

      {/* Expansion queue indicator */}
      <AnimatePresence>
        {queuedExpansions > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
              color: 'var(--muted-foreground)',
            }}
          >
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
              style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', borderTop: '2px solid var(--primary)', borderRight: '2px solid transparent' }}
            />
            {queuedExpansions === 1 ? 'Expanding…' : `${queuedExpansions} expansions queued`}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Undo / Redo — floats bottom-left when history is available */}
      {!isEmpty && (canUndo || canRedo) && (
        <div className="fixed bottom-20 left-4 z-30 flex items-center gap-2">
          <AnimatePresence>
            {canUndo && (
              <motion.button
                key="undo"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
                onClick={handleUndo}
                title="Undo last change (⌘Z / Ctrl+Z)"
                className="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors hover:bg-accent"
                style={{
                  background: 'var(--kg-node-bg)',
                  border: '1px solid var(--kg-node-border)',
                  boxShadow: 'var(--kg-shadow-md)',
                  color: 'var(--foreground)',
                }}
              >
                ↩ Undo
              </motion.button>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {canRedo && (
              <motion.button
                key="redo"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
                onClick={handleRedo}
                title="Redo (⌘Y / Ctrl+Y)"
                className="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 transition-colors hover:bg-accent"
                style={{
                  background: 'var(--kg-node-bg)',
                  border: '1px solid var(--kg-node-border)',
                  boxShadow: 'var(--kg-shadow-md)',
                  color: 'var(--foreground)',
                }}
              >
                ↪ Redo
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Side panels */}
      <SidePanel side="left" isOpen={leftPanel} onClose={() => setLeftPanel(false)} nodes={nodes} edges={edges} onNodeFocus={handleNodeFocus} onFocusMultiple={handleFocusMultiple} categories={categories} />
      <SidePanel side="right" isOpen={rightPanel} onClose={() => setRightPanel(false)} reasoningSteps={reasoningSteps} />

      {/* Floating query box — appears once the graph is loaded */}
      <AnimatePresence>
        {!isEmpty && !isProcessing && (
          <QueryBox
            onQuery={handleQuery}
            isQuerying={isQuerying}
            answer={queryAnswer}
            newNodesCount={queryNewNodesCount}
            onDismissAnswer={() => { setQueryAnswer(null); setQueryNewNodesCount(0); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export function KnowledgeGraphCanvas() {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphCanvasInner />
    </ReactFlowProvider>
  );
}
