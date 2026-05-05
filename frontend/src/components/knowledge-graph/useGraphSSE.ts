import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { openRunStream } from '@/lib/api';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';
import type { GraphLayoutNode } from './layout';
import type { AIReasoningStep } from './types';

// ── SSE payload types ─────────────────────────────────────────────────────────

export interface BackendNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface BackendEdge {
  source: string;
  target: string;
  predicate: string;
  confidence?: number;
  sources?: BackendSource[];
  properties?: Record<string, unknown>;
}

export interface BackendSource {
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

// Upsert a node by id, merging its properties into an existing node if one
// already exists. Newer property values win (e.g. a later scaffold emit can
// promote a regular node into the main entity), but the original label and
// position are preserved.
function upsertNodeById(prev: GraphNode[], incoming: GraphNode): GraphNode[] {
  const idx = prev.findIndex(n => n.id === incoming.id);
  if (idx === -1) return [...prev, incoming];
  const existing = prev[idx];
  const merged: GraphNode = {
    ...existing,
    data: {
      ...existing.data,
      ...incoming.data,
      label: (existing.data as GraphNodeData).label,
    },
  };
  if (existing === merged) return prev;
  const next = prev.slice();
  next[idx] = merged;
  return next;
}

// BFS from root → assign animDelay (seconds) per node/edge so center renders first.
// Stagger: stepMs = min(400, 2000 / maxDepth) — total animation ≤ 2s for deep graphs,
// up to 400ms/layer for shallow ones giving a premium 600-1200ms per-layer feel.
// Edges fire after both endpoint nodes so they "draw out" from visible nodes
// instead of appearing before their target has faded in.
function assignAnimDelays(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
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
      data: {
        ...(e.data ?? {}),
        animDelay: Math.max(depthMap.get(e.source) ?? 0, depthMap.get(e.target) ?? 0) * stepMs / 1000 + 0.18,
      },
    })),
  };
}

function formatSourceLabel(sources: BackendSource[]): string | undefined {
  const source = sources.find(item => item.title || item.url);
  if (!source) return undefined;
  return source.title || source.url.replace(/^local:\/\//, '');
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseGraphSSERefs {
  eventSourceRef: MutableRefObject<EventSource | null>;
  expansionAnchorRef: MutableRefObject<{ id: string; pos: { x: number; y: number } } | null>;
  expansionChildIdxRef: MutableRefObject<number>;
  expansionDepthRef: MutableRefObject<number>;
  expansionNewNodesRef: MutableRefObject<Set<string>>;
  pendingNodesRef: MutableRefObject<Map<string, GraphLayoutNode>>;
  pendingEdgesRef: MutableRefObject<Map<string, GraphEdge>>;
  layoutDebounceRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  nodesRef: MutableRefObject<GraphNode[]>;
  edgesRef: MutableRefObject<GraphEdge[]>;
  isSwarmExtraction: MutableRefObject<boolean>;
  queryModeRef: MutableRefObject<boolean>;
  appendModeRef: MutableRefObject<boolean>;
  activeNodeIdsRef: MutableRefObject<Set<string>>;
  userMovedRef: MutableRefObject<Set<string>>;
  nodePositionRef: MutableRefObject<Map<string, { x: number; y: number }>>;
  placeholderNodesRef: MutableRefObject<Set<string>>;
}

export interface UseGraphSSEHelpers {
  runLayoutAsync: (
    layoutNodes: GraphLayoutNode[],
    layoutEdges: GraphEdge[],
    manualPins: Set<string>,
  ) => Promise<Record<string, { x: number; y: number }>>;
  assignSpiralPosition: (nodeId: string) => { x: number; y: number };
  assignChildPosition: (sourceId: string, targetId: string) => { x: number; y: number } | null;
  scheduleAppendModeRelease: (delayMs?: number) => void;
}

export interface UseGraphSSEOptions {
  setNodes: Dispatch<SetStateAction<GraphNode[]>>;
  setEdges: Dispatch<SetStateAction<GraphEdge[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setReasoningSteps: Dispatch<SetStateAction<AIReasoningStep[]>>;
  setIsProcessing: Dispatch<SetStateAction<boolean>>;
  refs: UseGraphSSERefs;
  helpers: UseGraphSSEHelpers;
}

export function useGraphSSE(opts: UseGraphSSEOptions) {
  const { setNodes, setEdges, setActiveNodeId, setReasoningSteps, setIsProcessing, refs, helpers } = opts;
  const {
    eventSourceRef,
    expansionAnchorRef,
    expansionChildIdxRef,
    expansionDepthRef,
    expansionNewNodesRef,
    pendingNodesRef,
    pendingEdgesRef,
    layoutDebounceRef,
    nodesRef,
    edgesRef,
    isSwarmExtraction,
    queryModeRef,
    appendModeRef,
    activeNodeIdsRef,
    userMovedRef,
    nodePositionRef,
    placeholderNodesRef,
  } = refs;
  const { runLayoutAsync, assignSpiralPosition, assignChildPosition, scheduleAppendModeRelease } = helpers;

  const connectRunStream = useCallback((activeRunId: string) => {
    eventSourceRef.current?.close();

    const source = openRunStream(activeRunId);
    eventSourceRef.current = source;

    source.addEventListener('node.created', (e: MessageEvent) => {
      if (appendModeRef.current) scheduleAppendModeRelease();
      const envelope = JSON.parse(e.data) as SseEnvelope<{ node: BackendNode }>;
      const backendNode = envelope.payload.node;
      const anchor = expansionAnchorRef.current;
      const isRealMainEntity = backendNode.properties?.presentationRole === 'main_entity';

      // dedup: also check pending buffer, not just committed nodes
      const normalLabel = backendNode.label.toLowerCase().trim();
      const canDedupeByLabel = backendNode.type !== 'Document';
      const existingByLabel = canDedupeByLabel
        ? nodesRef.current.find(n => n.id !== backendNode.id && ((n.data as GraphNodeData).label ?? '').toLowerCase().trim() === normalLabel) ??
          [...pendingNodesRef.current.values()].find(n => n.id !== backendNode.id && n.data.label.toLowerCase().trim() === normalLabel)
        : undefined;
      if (existingByLabel) {
        if (appendModeRef.current) {
          const mergedData = {
            ...(existingByLabel.data as GraphNodeData),
            ...(backendNode.properties ?? {}),
            label: (existingByLabel.data as GraphNodeData).label,
            description: (existingByLabel.data as GraphNodeData).description,
          };
          setNodes(prev => prev.map(n => n.id === existingByLabel.id ? { ...n, data: mergedData } : n));
        }
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
        data: {
          label: backendNode.label,
          nodeType,
          description: backendNode.type,
          parentId: anchor?.id,
          ...(backendNode.properties ?? {}),
        },
      };
      activeNodeIdsRef.current.add(backendNode.id);

      if (isRealMainEntity) {
        setNodes(prev => prev.filter(node => (node.data as GraphNodeData).provisional !== true));
        pendingNodesRef.current.forEach((node, id) => {
          if ((node.data as GraphNodeData).provisional === true) pendingNodesRef.current.delete(id);
        });
        setActiveNodeId(backendNode.id);
      }

      if (anchor) {
        // Sequential subtree reveal: stagger each new expansion node so the
        // subtree appears as a wave from the anchor outward instead of all
        // at once. Index taken before .add so the first new node is delay 0.
        const expansionIdx = expansionNewNodesRef.current.size;
        const stepMs = 90;
        const newNodeWithDelay: GraphLayoutNode = {
          ...newNode,
          data: { ...newNode.data, animDelay: (expansionIdx * stepMs) / 1000 },
        };
        // Track this node so chain edges (newNode → newerNode) survive the
        // anchor-scope filter in edge.created — without this, intermediate
        // category nodes would never get their child items attached.
        expansionNewNodesRef.current.add(backendNode.id);
        // Expansion: commit immediately so the user sees progress
        setNodes(prev => upsertNodeById(prev, newNodeWithDelay));
        const bridgeEdgeId = `e-expand-${anchor.id}-${backendNode.id}`;
        // Edge fades in shortly after the target node so it reads as
        // drawing out *from* the anchor rather than appearing first.
        const bridgeAnimDelay = (expansionIdx * stepMs) / 1000 + 0.18;
        setEdges(prev => prev.some(ex => ex.id === bridgeEdgeId) ? prev : [...prev, {
          id: bridgeEdgeId, source: anchor.id, target: backendNode.id,
          label: 'expands', type: 'floating',
          data: { animDelay: bridgeAnimDelay },
        }]);
      } else if (queryModeRef.current) {
        const queryIdx = expansionNewNodesRef.current.size;
        const stepMs = 90;
        const newNodeWithDelay: GraphLayoutNode = {
          ...newNode,
          data: { ...newNode.data, animDelay: (queryIdx * stepMs) / 1000 },
        };
        // Query mode: commit immediately but no bridge edge; Sigma keeps the
        // camera stable while the graph updates.
        expansionNewNodesRef.current.add(backendNode.id);
        setNodes(prev => upsertNodeById(prev, newNodeWithDelay));
      } else {
        if (appendModeRef.current) {
          // Document uploads after the first graph should extend the current
          // graph in-place. Do not use the initial-load pending buffer here;
          // a later batch commit can replace the visible graph.
          setNodes(prev => upsertNodeById(prev, newNode));
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
                })) as GraphNode[];
              const merged = [...updated, ...additions];
              return assignAnimDelays(merged, [...edgesRef.current, ...pEdges]).nodes;
            });
            setEdges(prev => {
              const existingIds = new Set(prev.map(e => e.id));
              const additions = pEdges.filter(e => !existingIds.has(e.id));
              if (additions.length === 0) return prev;
              return [...prev, ...additions];
            });
            // Don't clear isProcessing here — that's the FIRST batch settling,
            // not the run completing. The processing indicator should remain
            // until the orchestrator emits run.completed / run.failed.
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
      if (appendModeRef.current) scheduleAppendModeRelease();
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
      // Inherit the target's expansion stagger so the edge draws in just
      // after its endpoint nodes appear, matching the bridge-edge behaviour.
      let inheritedAnimDelay: number | undefined;
      if (anchor) {
        const targetNode = nodesRef.current.find(n => n.id === backendEdge.target);
        const sourceNode = nodesRef.current.find(n => n.id === edgeSource);
        const targetDelay = (targetNode?.data as { animDelay?: number } | undefined)?.animDelay;
        const sourceDelay = (sourceNode?.data as { animDelay?: number } | undefined)?.animDelay;
        const maxDelay = Math.max(typeof targetDelay === 'number' ? targetDelay : 0, typeof sourceDelay === 'number' ? sourceDelay : 0);
        if (maxDelay > 0) inheritedAnimDelay = maxDelay + 0.18;
      }
      const edgeData = {
        confidence: backendEdge.confidence,
        sources: backendEdge.sources ?? [],
        sourceLabel: formatSourceLabel(backendEdge.sources ?? []),
        properties: backendEdge.properties ?? {},
        ...(inheritedAnimDelay !== undefined ? { animDelay: inheritedAnimDelay } : {}),
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
            data: edgeData,
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
      const addSource = (existing: GraphEdge): GraphEdge => {
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
        if (appendModeRef.current) scheduleAppendModeRelease();
        const envelope = JSON.parse(e.data) as SseEnvelope<{ agentName?: string; eventType?: string; message?: string; status?: string }>;
        const payload = envelope.payload;
        const eventType = payload.eventType ?? payload.status ?? envelope.type;
        const agentName = payload.agentName ?? '';
        if (agentName.includes('Agent') || agentName.includes('Supervisor') || agentName === 'MetaAgent') {
          isSwarmExtraction.current = true;
        }
        // MetaAgent emits `completed` once per `extractFromText` call, so it's
        // not a reliable "the whole run is done" signal in multi-file uploads.
        // The canvas's await chain in handleDataSubmit / handleUploadDocuments
        // is the authoritative dismiss point — it only resolves once every
        // extract finishes — so the SSE hook does not clear isProcessing here.
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

    const handleRunDone = (e: MessageEvent) => {
      try {
        const envelope = JSON.parse(e.data) as SseEnvelope<{ message?: string; status?: string }>;
        const eventType = envelope.type;
        setReasoningSteps(prev => [...prev, {
          id: `r-${Date.now()}-${prev.length}`,
          text: envelope.payload?.message ?? (eventType === 'run.failed' ? 'Run failed' : 'Run complete'),
          timestamp: new Date(envelope.timestamp || Date.now()),
          type: 'analysis',
        }]);
      } catch (err) {
        console.warn('[SSE] Failed to parse run.* event:', err);
      }
      setIsProcessing(false);
      if (appendModeRef.current) appendModeRef.current = false;
    };
    source.addEventListener('run.completed', handleRunDone);
    source.addEventListener('run.failed', handleRunDone);
  }, [
    setNodes,
    setEdges,
    setActiveNodeId,
    setReasoningSteps,
    setIsProcessing,
    eventSourceRef,
    expansionAnchorRef,
    expansionChildIdxRef,
    expansionDepthRef,
    expansionNewNodesRef,
    pendingNodesRef,
    pendingEdgesRef,
    layoutDebounceRef,
    nodesRef,
    edgesRef,
    isSwarmExtraction,
    queryModeRef,
    appendModeRef,
    activeNodeIdsRef,
    userMovedRef,
    nodePositionRef,
    placeholderNodesRef,
    runLayoutAsync,
    assignSpiralPosition,
    assignChildPosition,
    scheduleAppendModeRelease,
  ]);

  return { connectRunStream };
}
