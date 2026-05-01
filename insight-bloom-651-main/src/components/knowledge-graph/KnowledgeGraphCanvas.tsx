import { useCallback, useState, useMemo, useEffect, useRef } from 'react';
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
import { createRun, extractFromText, extractFromFile, openRunStream, expandSubtree as apiExpandSubtree, type ExpandContext } from '@/lib/api';

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
  const reactFlowInstance = useReactFlow();

  const nodeTypes = useMemo(() => ({ graphNode: GraphNodeMemo }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
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
  // Nodes the user has manually dragged — pinned so re-layouts after expansion
  // don't snap them back to their physics-determined position.
  const userMovedRef = useRef<Set<string>>(new Set());
  // Buffers for initial-load SSE events — committed all-at-once after layout so nodes
  // never appear in unsorted positions.
  const pendingNodesRef = useRef<Map<string, GraphLayoutNode>>(new Map());
  const pendingEdgesRef = useRef<Map<string, Edge>>(new Map());
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
      } else {
        // Initial load: buffer — nodes appear only after layout is done
        pendingNodesRef.current.set(backendNode.id, newNode);
      }

      // Debounced commit + layout — fires after the SSE burst settles
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      const debounceMs = 200; // Shorter for faster incremental rendering
      layoutDebounceRef.current = setTimeout(() => {
        const isBatchMode = !expansionAnchorRef.current;

        if (isBatchMode && pendingNodesRef.current.size > 0) {
          const pNodes = [...pendingNodesRef.current.values()];
          const pEdges = [...pendingEdgesRef.current.values()];
          pendingNodesRef.current.clear();
          pendingEdgesRef.current.clear();

          const allEdges = [...edgesRef.current, ...pEdges];
          const laidOut = layout(
            [...(nodesRef.current as GraphLayoutNode[]), ...pNodes],
            allEdges,
            userMovedRef.current,
          ) as Node[];

          const animated = assignAnimDelays(laidOut, allEdges);
          setNodes(animated.nodes);
          setEdges(animated.edges);
          setIsProcessing(false);

          // Double-rAF: first fires after React's commit, second after the browser paints layout
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              reactFlowInstance.fitView({ padding: 0.12, duration: 0 });
            });
          });
        } else {
          // Expansion: just re-layout existing committed nodes
          setNodes(prev => layout(prev as GraphLayoutNode[], edgesRef.current, userMovedRef.current) as Node[]);
        }
      }, 600);
    });

    source.addEventListener('edge.created', (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ edge: BackendEdge }>;
      const backendEdge = envelope.payload.edge;
      const anchor = expansionAnchorRef.current;

      const sourceInGraph =
        nodesRef.current.some(n => n.id === backendEdge.source) ||
        pendingNodesRef.current.has(backendEdge.source);
      const targetInGraph =
        nodesRef.current.some(n => n.id === backendEdge.target) ||
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
            data: { confidence: backendEdge.confidence },
          }];
        });
      } else {
        // Buffer edge for initial load — committed alongside nodes after layout
        if (!pendingEdgesRef.current.has(edgeId)) {
          pendingEdgesRef.current.set(edgeId, {
            id: edgeId, source: edgeSource, target: backendEdge.target,
            label: backendEdge.predicate, type: 'floating',
            data: { confidence: backendEdge.confidence },
          });
        }
      }
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
  }, [assignSpiralPosition, assignChildPosition, setNodes, setEdges]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      pendingNodesRef.current.clear();
      pendingEdgesRef.current.clear();
    };
  }, []);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

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
    isSwarmExtraction.current = false;

    setDataSources(prev => [...prev, {
      id: `ds-${Date.now()}`,
      name: documentName === 'input.txt' ? text.slice(0, 40) + (text.length > 40 ? '...' : '') : documentName,
      type: 'text',
      addedAt: new Date(),
    }]);

    try {
      const activeRunId = await createRun(text);
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
          ? e.label
          : (e.data as { predicate?: string })?.predicate ?? 'relates to';
        if (e.source === node.id) {
          const other = nodes.find(n => n.id === e.target);
          return { direction: 'out' as const, predicate, otherLabel: (other?.data as GraphNodeData)?.label ?? e.target };
        } else {
          const other = nodes.find(n => n.id === e.source);
          return { direction: 'in' as const, predicate, otherLabel: (other?.data as GraphNodeData)?.label ?? e.source };
        }
      });
    setSelectedNodeRelationships(rels);

    const childNodes = nodes.filter(n => childIds.has(n.id));
    const targetEl = ((_ as React.MouseEvent).currentTarget) as HTMLElement;
    const rect = targetEl.getBoundingClientRect();
    const boxWidth = 320;
    const boxHeight = 180;
    const nodeCenterX = rect.left + rect.width / 2;
    const nodeCenterY = rect.top + rect.height / 2;

    if (childNodes.length > 0 && reactFlowInstance) {
      const vp = reactFlowInstance.getViewport();
      let avgDx = 0, avgDy = 0;
      childNodes.forEach(c => {
        const screenX = c.position.x * vp.zoom + vp.x;
        const screenY = c.position.y * vp.zoom + vp.y;
        avgDx += screenX - (node.position.x * vp.zoom + vp.x);
        avgDy += screenY - (node.position.y * vp.zoom + vp.y);
      });
      avgDx /= childNodes.length;
      avgDy /= childNodes.length;

      const absDx = Math.abs(avgDx);
      const absDy = Math.abs(avgDy);
      let posX: number, posY: number;

      if (absDy > absDx) {
        posX = nodeCenterX - boxWidth / 2;
        posY = avgDy > 0 ? rect.top - boxHeight - 8 : rect.bottom + 8;
      } else {
        posY = nodeCenterY - boxHeight / 2;
        posX = avgDx > 0 ? rect.left - boxWidth - 8 : rect.right + 8;
      }

      posX = Math.max(8, Math.min(window.innerWidth - boxWidth - 8, posX));
      posY = Math.max(8, Math.min(window.innerHeight - boxHeight - 8, posY));
      setInputBoxPos({ x: posX, y: posY });
    } else {
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow >= boxHeight + 8) {
        setInputBoxPos({ x: nodeCenterX - boxWidth / 2, y: rect.bottom + 8 });
      } else {
        setInputBoxPos({ x: nodeCenterX - boxWidth / 2, y: rect.top - boxHeight - 8 });
      }
    }
  }, [edges, nodes, reactFlowInstance]);

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
    for (const file of files) {
      await extractFromFile(runId, file);
    }
  }, [runId]);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setInputBoxPos(null);
    setHighlightedNodes(new Set());
    setExpandedSubtree(new Set());
    setLeftPanel(false);
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
        isHighlighted: highlightedNodes.has(n.id),
        compact: isCompact && (n.data as GraphNodeData).nodeType !== 'root' && (childCount.get(n.id) || 0) < 3 && !expanded.has(n.id),
      },
    }));
  }, [nodes, edges, highlightedNodes, expandedSubtree, pinnedExpansion]);

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
        nodes={nodesWithHighlight}
        edges={edges}
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
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="w-full h-full"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        {!isEmpty && (
          <Controls
            showInteractive={false}
            position="bottom-center"
          />
        )}
      </ReactFlow>

      {/* Empty state blob */}
      {(isEmpty || isDissolving) && (
        <AnimatedBlob onDataSubmit={handleDataSubmit} isDissolving={isDissolving} />
      )}

      {/* Loading blob — shown from submit until first node arrives */}
      <LoadingBlob isVisible={isProcessing} reasoningSteps={reasoningSteps} />

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
      <SidePanel side="left" isOpen={leftPanel} onClose={() => setLeftPanel(false)} nodes={nodes} edges={edges} onNodeFocus={handleNodeFocus} />
      <SidePanel side="right" isOpen={rightPanel} onClose={() => setRightPanel(false)} reasoningSteps={reasoningSteps} />
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
