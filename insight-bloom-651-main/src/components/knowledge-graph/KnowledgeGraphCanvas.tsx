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
import { AnimatePresence } from 'framer-motion';

import { AnimatedBlob } from './AnimatedBlob';
import { GraphNodeMemo, calcNodeDims, type GraphNodeData } from './GraphNode';
import { NodeInputBox } from './NodeInputBox';
import { SidePanel } from './SidePanel';
import { TopNav } from './TopNav';
import { EdgeButton } from './EdgeButton';
import { FloatingEdge } from './FloatingEdge';
import type { AIReasoningStep, DataSource } from './types';
import type { NodeRelationship } from './NodeInputBox';
import { createRun, extractFromText, openRunStream, expandSubtree as apiExpandSubtree } from '@/lib/api';

type GraphLayoutNode = Node<GraphNodeData>;

// ── Force-directed layout ─────────────────────────────────────────────────────

function forceDirectedLayout(layoutNodes: GraphLayoutNode[], layoutEdges: Edge[]): GraphLayoutNode[] {
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
    layoutNodes.filter(n => (n.data as GraphNodeData).nodeType === 'root').map(n => n.id)
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

function resolveOverlaps(layoutNodes: GraphLayoutNode[]): GraphLayoutNode[] {
  if (layoutNodes.length < 2) return layoutNodes;

  const pos = new Map(layoutNodes.map(n => [n.id, { x: n.position.x, y: n.position.y }]));
  const dims = new Map(layoutNodes.map(n => [n.id, getNodeDims(n)]));
  const pinned = new Set(
    layoutNodes.filter(n => (n.data as GraphNodeData).nodeType === 'root').map(n => n.id)
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

function layout(nodes: GraphLayoutNode[], edges: Edge[]): GraphLayoutNode[] {
  return resolveOverlaps(forceDirectedLayout(nodes, edges));
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

// ── Component ─────────────────────────────────────────────────────────────────

function KnowledgeGraphCanvasInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isDissolving, setIsDissolving] = useState(false);
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
  const nodesRef = useRef<Node[]>([]);
  const expansionDepthRef = useRef<number>(0);
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgesRef = useRef<Edge[]>([]);

  useOnViewportChange({
    onChange: useCallback((vp: { x: number; y: number; zoom: number }) => {
      setViewport(vp);
    }, []),
  });

  // Keep edgesRef in sync so the layout debounce can read current edges
  useEffect(() => { edgesRef.current = edges; }, [edges]);

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

      // Case-insensitive label dedup against current graph
      const normalLabel = backendNode.label.toLowerCase().trim();
      const existingByLabel = nodesRef.current.find(
        n => n.id !== backendNode.id && ((n.data as GraphNodeData).label ?? '').toLowerCase().trim() === normalLabel
      );
      if (existingByLabel) {
        // Node already exists — draw a connecting edge instead of adding a duplicate
        if (anchor) {
          const reuseId = `e-reuse-${anchor.id}-${existingByLabel.id}`;
          setEdges(prev => prev.some(ex => ex.id === reuseId) ? prev : [...prev, {
            id: reuseId,
            source: anchor.id,
            target: existingByLabel.id,
            label: 'also connects',
            type: 'floating',
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
        pos = {
          x: anchor.pos.x + Math.cos(angle) * radius,
          y: anchor.pos.y + Math.sin(angle) * radius,
        };
      } else {
        pos = assignSpiralPosition(backendNode.id);
      }
      nodePositionRef.current.set(backendNode.id, pos);
      placeholderNodesRef.current.add(backendNode.id);

      // Depth-based nodeType: root=0 → topic, topic=1 → subtopic, subtopic/detail=2+ → detail
      const parentDepth = expansionDepthRef.current;
      const nodeType: GraphNodeData['nodeType'] =
        parentDepth === 0 ? 'topic' :
        parentDepth === 1 ? 'subtopic' : 'detail';

      setNodes(prev => {
        if (prev.some(n => n.id === backendNode.id)) return prev;
        return [...prev, {
          id: backendNode.id,
          type: 'graphNode',
          position: pos,
          data: {
            label: backendNode.label,
            nodeType,
            description: backendNode.type,
            parentId: anchor?.id,
          },
        } as GraphLayoutNode];
      });

      // Debounced full layout — runs after the burst of node.created events settles.
      // Uses force-directed layout (spring forces along edges pull connected nodes
      // together, repulsion pushes unrelated ones apart) then resolves overlaps.
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      layoutDebounceRef.current = setTimeout(() => {
        setNodes(prev => layout(prev as GraphLayoutNode[], edgesRef.current) as Node[]);
      }, 600);

      if (anchor) {
        const bridgeEdgeId = `e-expand-${anchor.id}-${backendNode.id}`;
        setEdges(prev => prev.some(ex => ex.id === bridgeEdgeId) ? prev : [...prev, {
          id: bridgeEdgeId,
          source: anchor.id,
          target: backendNode.id,
          label: 'expands',
          type: 'floating',
        }]);
      }
    });

    source.addEventListener('edge.created', (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ edge: BackendEdge }>;
      const backendEdge = envelope.payload.edge;
      const anchor = expansionAnchorRef.current;

      const sourceInGraph = nodesRef.current.some(n => n.id === backendEdge.source);
      const targetInGraph = nodesRef.current.some(n => n.id === backendEdge.target);

      // Skip edges where neither node exists in the graph — they're invisible and can't
      // create hierarchy. Also skip when an anchor is active and this edge routes through
      // a node other than the anchor (prevents off-target nodes like the root company
      // from "claiming" children that belong to the clicked sub-node).
      if (!sourceInGraph && !targetInGraph) return;
      if (anchor && sourceInGraph && backendEdge.source !== anchor.id) return;

      // Reposition a placeholder target now that its real source is known
      const newPos = assignChildPosition(backendEdge.source, backendEdge.target);
      if (newPos) {
        setNodes(prev => prev.map(n => n.id === backendEdge.target ? { ...n, position: newPos } : n));
      }

      // When anchor is active and source doesn't exist in the graph (e.g. demo node IDs
      // differ from backend-normalised IDs), route the edge from the anchor so the
      // predicate label is visible on the correct connector.
      const edgeSource = sourceInGraph ? backendEdge.source : (anchor?.id ?? backendEdge.source);
      const edgeId = `${edgeSource}:${backendEdge.predicate}:${backendEdge.target}`;

      setEdges(prev => {
        if (prev.some(edge => edge.id === edgeId)) return prev;
        // Replace the generic "expands" bridge edge with this semantically labelled one
        const filtered = edgeSource === anchor?.id
          ? prev.filter(ex => ex.id !== `e-expand-${anchor.id}-${backendEdge.target}`)
          : prev;
        return [...filtered, {
          id: edgeId,
          source: edgeSource,
          target: backendEdge.target,
          label: backendEdge.predicate,
          type: 'floating',
          data: { confidence: backendEdge.confidence },
        }];
      });
    });

    const addReasoning = (e: MessageEvent) => {
      const envelope = JSON.parse(e.data) as SseEnvelope<{ agentName?: string; eventType?: string; message?: string; status?: string }>;
      const payload = envelope.payload;
      const eventType = payload.eventType ?? payload.status ?? envelope.type;
      setReasoningSteps(prev => [...prev, {
        id: `r-${Date.now()}-${prev.length}`,
        text: payload.message ?? `[${payload.agentName ?? 'System'}] ${eventType}`,
        timestamp: new Date(envelope.timestamp || Date.now()),
        type: eventType.includes('expand') ? 'expansion' : eventType.includes('connect') ? 'connection' : 'analysis',
      }]);
    };

    source.addEventListener('agent.step', addReasoning);
    source.addEventListener('run.status', addReasoning);
  }, [assignSpiralPosition, assignChildPosition, setNodes, setEdges]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
    };
  }, []);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  const handleDataSubmit = useCallback(async (text: string, documentName = 'input.txt') => {
    setIsDissolving(true);
    expansionAnchorRef.current = null;
    expansionChildIdxRef.current = 0;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    nodePositionRef.current.clear();
    childCountRef.current.clear();
    placeholderNodesRef.current.clear();
    setNodes([]);
    setEdges([]);
    setReasoningSteps([]);

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

  const handleNodeAction = useCallback(async (action: string, prompt: string) => {
    if (!selectedNode) return;

    const nodeData = selectedNode.data as GraphNodeData;

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

    // Set expansion anchor — start child index after existing children so new nodes don't overlap
    expansionAnchorRef.current = { id: selectedNode.id, pos: { ...selectedNode.position } };
    expansionChildIdxRef.current = edges.filter(e => e.source === selectedNode.id).length;
    expansionDepthRef.current = computeNodeDepth(selectedNode.id, edges);

    // ── Collect subtree going DOWN (children of selected node) ──────────────
    const subtreeIds = new Set<string>([selectedNode.id]);
    const downQueue = [selectedNode.id];
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
    const upQueue = [selectedNode.id];
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
      (ancestorIds.has(e.source) && (ancestorIds.has(e.target) || e.target === selectedNode.id)) ||
      (ancestorIds.has(e.target) && ancestorIds.has(e.source))
    );

    // ── Build breadcrumb path for question context ───────────────────────────
    const breadcrumb: string[] = [];
    let cursor = selectedNode.id;
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
      id: selectedNode.id,
      label: nodeData.label,
      type: nodeData.description ?? 'Entity',
    };

    const getLabel = (id: string) => (nodes.find(n => n.id === id)?.data as GraphNodeData)?.label ?? id;
    const getPredicate = (e: Edge) =>
      (typeof e.label === 'string' && e.label ? e.label : (e.data as { predicate?: string })?.predicate) ?? 'related_to';

    const contextNodes = [
      ...subtreeNodes.filter(n => n.id !== selectedNode.id),
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

    const label = nodeData.label;
    const pathContext = breadcrumb.length > 1 ? ` (context path: ${contextPath})` : '';
    const defaultQuestions: Record<string, string> = {
      expand:   `What are the key sub-topics, components, and specific facts about "${label}"${pathContext}? Include concrete names, figures, and examples relevant specifically to this context.`,
      research: `Do deep research on "${label}"${pathContext}. Find: recent statistics, key players, market size or scale, major trends, challenges, and specific recent developments. Only include information relevant to this specific context, not generic results.`,
      connect:  `Map the relationship network of "${label}"${pathContext}. What companies, people, markets, technologies, regulations, and events is it directly connected to within this context? Focus on dependencies and influences.`,
    };
    const question = prompt
      ? `${prompt} — specifically about "${label}"${pathContext}`
      : defaultQuestions[action] ?? `Expand "${label}"${pathContext} with more details`;

    setReasoningSteps(prev => [...prev, {
      id: `r-${Date.now()}`,
      text: `Expanding "${nodeData.label}" — searching for "${question}"…`,
      timestamp: new Date(),
      type: 'expansion',
    }]);

    try {
      const result = await apiExpandSubtree(runId, rootNode, contextNodes, contextEdges, question);
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
    }
  }, [selectedNode, runId, nodes, edges, setNodes, setEdges]);

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

  const handleLoadSample = useCallback(() => {
    const sampleNodes: GraphLayoutNode[] = [
      { id: 'n1', type: 'graphNode', position: { x: 0, y: 0 },     data: { label: 'AI',                                        nodeType: 'root',     description: undefined } },
      { id: 'n2', type: 'graphNode', position: { x: 250, y: -80 },  data: { label: 'Machine Learning',                          nodeType: 'topic',    description: 'Topic' } },
      { id: 'n3', type: 'graphNode', position: { x: 250, y: 80 },   data: { label: 'Natural Language Processing',               nodeType: 'topic',    description: 'Topic' } },
      { id: 'n4', type: 'graphNode', position: { x: 500, y: -160 }, data: { label: 'Large Language Model Training',             nodeType: 'subtopic', description: 'Technology' } },
      { id: 'n5', type: 'graphNode', position: { x: 500, y: -40 },  data: { label: 'Retrieval Augmented Generation System',     nodeType: 'subtopic', description: 'Technology' } },
      { id: 'n6', type: 'graphNode', position: { x: 500, y: 80 },   data: { label: 'Transformer Architecture Design',           nodeType: 'subtopic', description: 'Concept' } },
      { id: 'n7', type: 'graphNode', position: { x: 500, y: 200 },  data: { label: 'OpenAI',                                    nodeType: 'subtopic', description: 'Company' } },
      { id: 'n8', type: 'graphNode', position: { x: 750, y: -200 }, data: { label: 'Gradient descent optimisation loop',        nodeType: 'detail',   description: 'Concept' } },
      { id: 'n9', type: 'graphNode', position: { x: 750, y: -80 },  data: { label: 'Vector database',                          nodeType: 'detail',   description: 'Technology' } },
      { id: 'n10',type: 'graphNode', position: { x: 750, y: 40 },   data: { label: 'Multi-head self-attention mechanism',       nodeType: 'detail',   description: 'Concept' } },
    ];
    const sampleEdges: Edge[] = [
      { id: 'e1-2',  source: 'n1', target: 'n2',  label: 'includes',   type: 'floating' },
      { id: 'e1-3',  source: 'n1', target: 'n3',  label: 'includes',   type: 'floating' },
      { id: 'e2-4',  source: 'n2', target: 'n4',  label: 'uses',       type: 'floating' },
      { id: 'e2-5',  source: 'n2', target: 'n5',  label: 'uses',       type: 'floating' },
      { id: 'e3-6',  source: 'n3', target: 'n6',  label: 'built on',   type: 'floating' },
      { id: 'e3-7',  source: 'n3', target: 'n7',  label: 'pioneered by', type: 'floating' },
      { id: 'e4-8',  source: 'n4', target: 'n8',  label: 'requires',   type: 'floating' },
      { id: 'e5-9',  source: 'n5', target: 'n9',  label: 'relies on',  type: 'floating' },
      { id: 'e6-10', source: 'n6', target: 'n10', label: 'contains',   type: 'floating' },
    ];
    setNodes(sampleNodes);
    setEdges(sampleEdges);
    setIsEmpty(false);
    setTimeout(() => reactFlowInstance.fitView({ padding: 0.2, duration: 400 }), 50);
  }, [setNodes, setEdges, reactFlowInstance]);

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
        onLoadSample={handleLoadSample}
      />

      <EdgeButton side="left" label="Contents" icon="📑" onClick={() => setLeftPanel(p => !p)} isActive={leftPanel} />
      <EdgeButton side="right" label="Reasoning" icon="🧠" onClick={() => setRightPanel(p => !p)} isActive={rightPanel} />

      <ReactFlow
        nodes={nodesWithHighlight}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
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
        <Controls
          showInteractive={false}
          position="bottom-center"
        />
      </ReactFlow>

      {/* Empty state blob */}
      {(isEmpty || isDissolving) && (
        <AnimatedBlob onDataSubmit={handleDataSubmit} isDissolving={isDissolving} />
      )}

      {/* Node input box */}
      <AnimatePresence>
        {selectedNode && inputBoxPos && (
          <NodeInputBox
            nodeLabel={(selectedNode.data as GraphNodeData).label}
            entityType={(selectedNode.data as GraphNodeData).description}
            relationships={selectedNodeRelationships}
            position={inputBoxPos}
            onAction={handleNodeAction}
            onClose={() => { setSelectedNode(null); setInputBoxPos(null); setSelectedNodeRelationships([]); }}
          />
        )}
      </AnimatePresence>

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
