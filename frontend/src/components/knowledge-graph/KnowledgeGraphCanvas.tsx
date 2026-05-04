import { useCallback, useState, useMemo, useEffect, useRef, useDeferredValue } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { AnimatedBlob, LoadingBlob } from './AnimatedBlob';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';
import { GraphSearchPanel } from './GraphSearchPanel';
import { NodeInputBox } from './NodeInputBox';
import { DocumentNodePanel } from './DocumentNodePanel';
import { SummaryDetailPanel, type SummaryDetail } from './SummaryDetailPanel';
import { SidePanel } from './SidePanel';
import { TopNav } from './TopNav';
import { EdgeButton } from './EdgeButton';
import { KnowledgeGraphRenderer } from './KnowledgeGraphRenderer';
import {
  buildPresentationView,
  chooseInitialCenter,
  isMainEntityNode,
  isPresentationNodeId,
  isRealCategoryNode,
  isRealDocumentNode,
} from './presentationGraph';
import type { AIReasoningStep, DataSource } from './types';
import type { NodeRelationship } from './NodeInputBox';
import { createRun, extractFromText, queryGraph as apiQueryGraph, categorizeNodes, nestLevel1Entities, type NodeCategory } from '@/lib/api';
import { extractFileText } from '@/lib/pdf';
import { QueryBox } from './QueryBox';
import { layout, type GraphLayoutNode } from './layout';
import { useGraphSSE, type BackendSource } from './useGraphSSE';
import { useExpansion } from './useExpansion';
import {
  GraphFilterPanel,
  type GraphFilters,
  applyFilters,
  hasActiveFilters,
  makeEmptyFilters,
} from './GraphFilterPanel';

function formatPredicateLabel(predicate: string): string {
  return predicate.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueNonEmpty(values: Array<string | undefined>, limit: number): string[] {
  return values
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, limit);
}

function arrayProperty(data: GraphNodeData, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function buildSummaryDetail(node: GraphNode, graphNodes: GraphNode[], graphEdges: GraphEdge[]): SummaryDetail {
  const data = node.data as GraphNodeData;
  const nodeMap = new Map(graphNodes.map(item => [item.id, item]));
  const directEdges = graphEdges.filter(edge => edge.source === node.id || edge.target === node.id);
  const directNodeIds = new Set(directEdges.map(edge => edge.source === node.id ? edge.target : edge.source));

  const documentIds = new Set<string>();
  const entityIds = new Set<string>();
  for (const id of directNodeIds) {
    const related = nodeMap.get(id);
    if (!related) continue;
    if (isRealDocumentNode(related)) documentIds.add(id);
    else if (!isRealCategoryNode(related)) entityIds.add(id);
  }

  const documentEdges = isRealCategoryNode(node)
    ? graphEdges.filter(edge => documentIds.has(edge.source) || documentIds.has(edge.target))
    : [];
  const relevantEdges = [...directEdges, ...documentEdges];

  const facts = uniqueNonEmpty([
    ...arrayProperty(data, 'topFacts'),
    ...relevantEdges.map(edge => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) return undefined;
      const sourceLabel = (source.data as GraphNodeData).label;
      const targetLabel = (target.data as GraphNodeData).label;
      const predicate = typeof edge.label === 'string' && edge.label ? formatPredicateLabel(edge.label) : 'relates to';
      return `${sourceLabel} ${predicate} ${targetLabel}.`;
    }),
  ], 10);

  const risks = uniqueNonEmpty([
    ...arrayProperty(data, 'risksOrOpenQuestions'),
    ...facts.filter(fact => /\b(risk|exposure|liability|delay|dependency|obligation|compliance|breach|constraint|vulnerability)\b/i.test(fact)),
  ], 8);

  const sources = uniqueNonEmpty(
    relevantEdges.flatMap(edge => ((edge.data as { sources?: BackendSource[] } | undefined)?.sources ?? [])
      .map(source => source.title || source.url || source.snippet)),
    10,
  );

  return {
    title: data.label,
    type: String(data.description ?? (isRealDocumentNode(node) ? 'Document' : isRealCategoryNode(node) ? 'Category' : 'Node')),
    summary: typeof data.summary === 'string'
      ? data.summary
      : typeof data.documentSummary === 'string'
        ? data.documentSummary
        : undefined,
    documents: uniqueNonEmpty([
      ...arrayProperty(data, 'keyDocuments'),
      ...[...documentIds].map(id => (nodeMap.get(id)?.data as GraphNodeData | undefined)?.label),
    ], 10),
    entities: uniqueNonEmpty([...entityIds].map(id => (nodeMap.get(id)?.data as GraphNodeData | undefined)?.label), 12),
    facts,
    risks,
    sources,
  };
}

function normalizeQueryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findReferencedNode(question: string, graphNodes: GraphNode[]): GraphNode | null {
  const normalizedQuestion = ` ${normalizeQueryText(question)} `;
  const candidates = graphNodes
    .map(node => {
      const label = String((node.data as GraphNodeData).label ?? '');
      const normalizedLabel = normalizeQueryText(label);
      return { node, label, normalizedLabel };
    })
    .filter(candidate => candidate.normalizedLabel.length >= 3)
    .sort((a, b) => b.normalizedLabel.length - a.normalizedLabel.length);

  return candidates.find(candidate => normalizedQuestion.includes(` ${candidate.normalizedLabel} `))?.node ?? null;
}

// ── Component ─────────────────────────────────────────────────────────────────

function KnowledgeGraphCanvasInner() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isDissolving, setIsDissolving] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [inputBoxPos, setInputBoxPos] = useState<{ x: number; y: number } | null>(null);
  const [summaryDetail, setSummaryDetail] = useState<SummaryDetail | null>(null);
  const [leftPanel, setLeftPanel] = useState(false);
  const [rightPanel, setRightPanel] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [connectionMode, setConnectionMode] = useState(false);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [selectedNodeRelationships, setSelectedNodeRelationships] = useState<NodeRelationship[]>([]);
  const [reasoningSteps, setReasoningSteps] = useState<AIReasoningStep[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<GraphFilters>(() => makeEmptyFilters());
  const [categories, setCategories] = useState<NodeCategory[]>([]);
  const categorizationCountRef = useRef(0);
  const [isQuerying, setIsQuerying] = useState(false);
  const [queryAnswer, setQueryAnswer] = useState<string | null>(null);
  const [queryNewNodesCount, setQueryNewNodesCount] = useState(0);
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
    (layoutNodes: GraphLayoutNode[], layoutEdges: GraphEdge[], manualPins: Set<string>): Promise<Record<string, { x: number; y: number }>> => {
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

  // Neighborhood rendering: only mount the active node + its 1-hop neighbors.
  // Each rendered node carries a `hiddenCount` badge showing how many of its
  // OWN neighbors are off-canvas, so the user can see where more graph hangs.
  // showAllNodes toggles to the full view (e.g. via search panel).
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [showAllNodes, setShowAllNodes] = useState(false);

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
  const nodesRef = useRef<GraphNode[]>([]);
  const expansionDepthRef = useRef<number>(0);
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgesRef = useRef<GraphEdge[]>([]);
  const nestedRunIdsRef = useRef<Set<string>>(new Set());
  const isSwarmExtraction = useRef(false);
  // Set to true while a graph query is in flight so SSE nodes commit immediately
  // without batch buffering — same as expansion mode but anchorless.
  const queryModeRef = useRef(false);
  // Nodes the user has manually dragged — pinned so re-layouts after expansion
  // don't snap them back to their physics-determined position.
  const userMovedRef = useRef<Set<string>>(new Set());
  // Buffers for initial-load SSE events — committed all-at-once after layout so nodes
  // never appear in unsorted positions.
  const pendingNodesRef = useRef<Map<string, GraphLayoutNode>>(new Map());
  const pendingEdgesRef = useRef<Map<string, GraphEdge>>(new Map());
  const appendModeRef = useRef(false);
  const appendModeReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeIdsRef = useRef<Set<string>>(new Set());
  // Undo history — snapshots of {nodes, edges} before each expansion/deletion
  const historyRef = useRef<Array<{ nodes: GraphNode[]; edges: GraphEdge[] }>>([]);
  const redoStackRef = useRef<Array<{ nodes: GraphNode[]; edges: GraphEdge[] }>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Nodes created during the CURRENT expansion task — chain edges (new node →
  // newer node) need this set to survive the anchor-scope filter in edge.created.
  const expansionNewNodesRef = useRef<Set<string>>(new Set());

  const scheduleAppendModeRelease = useCallback((delayMs = 4500) => {
    if (!appendModeRef.current) return;
    if (appendModeReleaseTimerRef.current) clearTimeout(appendModeReleaseTimerRef.current);
    appendModeReleaseTimerRef.current = setTimeout(() => {
      appendModeRef.current = false;
      appendModeReleaseTimerRef.current = null;
      setIsProcessing(false);
    }, delayMs);
  }, []);

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

  const { connectRunStream } = useGraphSSE({
    setNodes,
    setEdges,
    setActiveNodeId,
    setReasoningSteps,
    setIsProcessing,
    refs: {
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
    },
    helpers: {
      runLayoutAsync,
      assignSpiralPosition,
      assignChildPosition,
      scheduleAppendModeRelease,
    },
  });

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
      if (appendModeReleaseTimerRef.current) clearTimeout(appendModeReleaseTimerRef.current);
      pendingNodesRef.current.clear();
      pendingEdgesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
    activeNodeIdsRef.current = new Set(nodes.map(node => node.id));
  }, [nodes]);

  const handleDataSubmit = useCallback(async (
    text: string,
    documentName = 'input.txt',
    additionalFiles: Array<{ name: string; text: string }> = [],
  ) => {
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
    nestedRunIdsRef.current.clear();
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

    let activeRunId: string | null = null;

    try {
      // Use the document name (or a short excerpt) as the run topic — never the
      // full document text, which gets stored as the root context and injected
      // into every extraction system prompt, blowing the token limit.
      const runTopic = (documentName && documentName !== 'input.txt')
        ? documentName.replace(/\.[^/.]+$/, '')
        : text.slice(0, 80).trim();
      activeRunId = await createRun(runTopic);
      setRunId(activeRunId);
      // No provisional centre node anymore — the LoadingBlob is shown while
      // the graph is empty, and disappears once the orchestrator emits the
      // real main_entity. Avoids the brief "first document file as a node"
      // flash that confused users.
      connectRunStream(activeRunId);
      setIsEmpty(false);
      setIsDissolving(false);
      await extractFromText(activeRunId, text, documentName);
      // Run the remaining files sequentially against the same run so each file
      // becomes its own Document scaffold node.
      for (const file of additionalFiles) {
        setDataSources(prev => [...prev, {
          id: `ds-${Date.now()}-${file.name}`,
          name: file.name,
          type: 'file',
          addedAt: new Date(),
        }]);
        try {
          await extractFromText(activeRunId, file.text, file.name);
        } catch (fileError) {
          const message = fileError instanceof Error ? fileError.message : `Failed to extract ${file.name}`;
          console.error(message, fileError);
          setReasoningSteps(prev => [...prev, {
            id: `upload-error-${Date.now()}-${file.name}`,
            text: `${file.name}: ${message}`,
            timestamp: new Date(),
            type: 'analysis',
          }]);
        }
      }
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
      // Clear the loading indicator now — the await chain above only resolves
      // after each per-file MetaAgent run finishes, so this is the real
      // "everything is done" signal for the initial run. The level-1 nesting
      // pass runs from an effect after SSE state has settled into refs.
      setIsProcessing(false);
      setIsDissolving(false);
    }
  }, [connectRunStream, setNodes, setEdges]);

  // Sort level-1 entities (direct children of the main entity that aren't
  // themselves categories or documents) into the closest existing category.
  // The new `category groups entity` triples arrive via SSE and the layout
  // reroutes the entity under its category at depth 2.
  const runNestLevel1 = useCallback(async (activeRunId: string) => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const main = currentNodes.find(n => (n.data as GraphNodeData).presentationRole === 'main_entity')
      ?? currentNodes.find(n => (n.data as GraphNodeData).nodeType === 'root');
    if (!main) return;

    const isCategory = (node: GraphNode) => {
      const data = node.data as GraphNodeData;
      return data.presentationRole === 'category' ||
        data.presentationRole === 'business_area' ||
        String(data.description ?? '').toLowerCase() === 'category';
    };
    const isDocument = (node: GraphNode) => {
      const data = node.data as GraphNodeData;
      if (data.presentationRole === 'document') return true;
      const desc = String(data.description ?? '').toLowerCase();
      return desc === 'document';
    };

    const categories = currentNodes
      .filter(isCategory)
      .filter(n => String((n.data as GraphNodeData).label ?? '').trim().toLowerCase() !== 'documents')
      .map(n => ({ id: n.id, label: (n.data as GraphNodeData).label }));
    if (categories.length === 0) return;

    const neighbourIds = new Set<string>();
    for (const e of currentEdges) {
      if (e.source === main.id) neighbourIds.add(e.target);
      if (e.target === main.id) neighbourIds.add(e.source);
    }

    const orphanEntities = currentNodes.filter(n =>
      neighbourIds.has(n.id) &&
      !isCategory(n) &&
      !isDocument(n) &&
      n.id !== main.id,
    );
    if (orphanEntities.length === 0) return;

    const entities = orphanEntities.map(n => {
      const data = n.data as GraphNodeData;
      return { id: n.id, label: data.label, type: String(data.description ?? data.nodeType ?? 'Entity') };
    });
    const mainLabel = (main.data as GraphNodeData).label;

    setReasoningSteps(prev => [...prev, {
      id: `nest-${Date.now()}`,
      text: `Sorting ${entities.length} unsorted entities under ${categories.length} categories…`,
      timestamp: new Date(),
      type: 'analysis',
    }]);

    const result = await nestLevel1Entities(activeRunId, categories, entities, mainLabel);
    if (result.newTriplesPersisted > 0) {
      setReasoningSteps(prev => [...prev, {
        id: `nest-done-${Date.now()}`,
        text: `Nested ${result.assignments.length} entities under categories.`,
        timestamp: new Date(),
        type: 'connection',
      }]);
    }
  }, []);

  useEffect(() => {
    if (!runId || isProcessing || nestedRunIdsRef.current.has(runId)) return;
    const main = nodes.find(node => isMainEntityNode(node) || (node.data as GraphNodeData).nodeType === 'root');
    const hasCategory = nodes.some(node => isRealCategoryNode(node));
    if (!main || !hasCategory || edges.length === 0) return;
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const hasDirectEntity = edges.some(edge => {
      if (edge.source !== main.id && edge.target !== main.id) return false;
      const other = nodeById.get(edge.source === main.id ? edge.target : edge.source);
      return Boolean(other && !isRealCategoryNode(other) && !isRealDocumentNode(other));
    });
    if (!hasDirectEntity) return;

    const timer = setTimeout(() => {
      if (nestedRunIdsRef.current.has(runId)) return;
      nestedRunIdsRef.current.add(runId);
      void runNestLevel1(runId).catch(err => {
        nestedRunIdsRef.current.delete(runId);
        console.warn('[nestLevel1] failed:', err);
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, [edges.length, isProcessing, nodes, runId, runNestLevel1]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: GraphNode) => {
    setActiveNodeId(node.id);

    if ((node.data as GraphNodeData).isVirtualPresentation) {
      setSelectedNode(node);
      const data = node.data as GraphNodeData;
      const summary = typeof data.documentSummary === 'string' && data.documentSummary.trim()
        ? data.documentSummary
        : undefined;
      setSelectedNodeRelationships(summary ? [{
        direction: 'out' as const,
        predicate: 'summary',
        otherLabel: summary,
      }] : []);
      const boxHeight = 180;
      setInputBoxPos({ x: 24, y: window.innerHeight / 2 - boxHeight / 2 });
      return;
    }

    if (isRealCategoryNode(node) || isRealDocumentNode(node)) {
      setSelectedNode(node);
      const data = node.data as GraphNodeData;
      const summary = typeof data.summary === 'string' && data.summary.trim()
        ? data.summary
        : typeof data.documentSummary === 'string' && data.documentSummary.trim()
          ? data.documentSummary
          : undefined;
      setSelectedNodeRelationships(summary ? [{
        direction: 'out' as const,
        predicate: 'summary',
        otherLabel: summary,
      }] : []);
      const boxHeight = 180;
      setInputBoxPos({ x: 24, y: window.innerHeight / 2 - boxHeight / 2 });
      return;
    }

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

  const openSummaryForNode = useCallback((node: GraphNode) => {
    setSummaryDetail(buildSummaryDetail(node, nodesRef.current, edgesRef.current));
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

  const handleDeleteDocument = useCallback(() => {
    if (!selectedNode || !isRealDocumentNode(selectedNode)) return;

    const documentId = selectedNode.id;
    const documentEdges = edgesRef.current.filter(edge => edge.source === documentId || edge.target === documentId);
    const remainingEdges = edgesRef.current.filter(edge => edge.source !== documentId && edge.target !== documentId);
    const maybeDocumentOnlyIds = new Set<string>();

    for (const edge of documentEdges) {
      if (edge.source !== documentId) maybeDocumentOnlyIds.add(edge.source);
      if (edge.target !== documentId) maybeDocumentOnlyIds.add(edge.target);
    }

    const nodesToDelete = new Set<string>([documentId]);
    for (const id of maybeDocumentOnlyIds) {
      const stillConnected = remainingEdges.some(edge => edge.source === id || edge.target === id);
      const node = nodesRef.current.find(item => item.id === id);
      if (!stillConnected && node && !isRealCategoryNode(node) && !isRealDocumentNode(node)) {
        nodesToDelete.add(id);
      }
    }

    pushHistory();
    nodesToDelete.forEach(id => {
      userMovedRef.current.delete(id);
      nodePositionRef.current.delete(id);
    });
    setNodes(prev => prev.filter(node => !nodesToDelete.has(node.id)));
    setEdges(prev => prev.filter(edge => !nodesToDelete.has(edge.source) && !nodesToDelete.has(edge.target)));
    setSelectedNode(null);
    setInputBoxPos(null);
    setSelectedNodeRelationships([]);
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

  const { handleNodeAction } = useExpansion({
    selectedNode,
    runId,
    nodes,
    edges,
    setReasoningSteps,
    setSelectedNode,
    setInputBoxPos,
    setExpandingNodeId,
    setAiHighlightedNodes,
    setQueuedExpansions,
    pushHistory,
    refs: {
      expansionAnchorRef,
      expansionChildIdxRef,
      expansionDepthRef,
      expansionNewNodesRef,
      expansionQueueRef,
      expansionRunningRef,
    },
  });

  const handleNodeFocus = useCallback((nodeId: string) => {
    setShowAllNodes(false);
    setActiveNodeId(nodeId);
  }, []);

  const handleFocusMultiple = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    const targets = nodes.filter(n => nodeIds.includes(n.id));
    if (targets.length === 0) return;
    const ids = new Set(nodeIds);
    setShowAllNodes(true);
    setActiveNodeId(null);
    setHighlightedNodes(ids);
  }, [nodes]);

  const handleUploadDocuments = useCallback(async (files: File[]) => {
    if (!runId) return;
    if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
      connectRunStream(runId);
    }

    appendModeRef.current = true;
    scheduleAppendModeRelease(30000);
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
    appendModeRef.current = false;
    setIsProcessing(false);
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
        if (cats.length > 0) {
          setCategories(cats);
          const categoryByNodeId = new Map<string, string>();
          for (const category of cats) {
            for (const nodeId of category.nodeIds) categoryByNodeId.set(nodeId, category.label);
          }
          setNodes(prev => prev.map(node => {
            const semanticCategory = categoryByNodeId.get(node.id);
            return semanticCategory
              ? { ...node, data: { ...node.data, semanticCategory } }
              : node;
          }));
        }
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
    const referencedNode = findReferencedNode(question, nodesRef.current);

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
      if (referencedNode) {
        setActiveNodeId(referencedNode.id);
        setShowAllNodes(false);
        const focusIds = new Set<string>([referencedNode.id, ...newQueryNodeIds]);
        for (const edge of edgesRef.current) {
          if (edge.source === referencedNode.id) focusIds.add(edge.target);
          if (edge.target === referencedNode.id) focusIds.add(edge.source);
        }
        setHighlightedNodes(new Set([referencedNode.id]));

      }
      if (newQueryNodeIds.size > 0) {
        setAiHighlightedNodes(new Set(referencedNode ? [referencedNode.id, ...newQueryNodeIds] : [...newQueryNodeIds]));
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
    setLeftPanel(false);
    // Clicking empty pane re-clusters: drop back to neighborhood
    setShowAllNodes(false);
  }, []);

  const nodesWithHighlight = useMemo(() => {
    return nodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        isHighlighted: highlightedNodes.has(n.id) || aiHighlightedNodes.has(n.id),
      },
    }));
  }, [nodes, highlightedNodes, aiHighlightedNodes]);

  // Auto-focus the first node that arrives. Prefer the orchestrator-tagged
  // main entity, then the most-connected non-document/non-category node — so a
  // document or scaffold category can never become the auto-center, even if
  // it's the most-connected node in the SSE stream.
  useEffect(() => {
    if (nodes.length === 0) return;
    const activeNode = activeNodeId ? nodes.find(node => node.id === activeNodeId) : null;
    const main = nodes.find(node => isMainEntityNode(node) && (node.data as GraphNodeData).provisional !== true);
    if (main && (!activeNode || isRealDocumentNode(activeNode) || isRealCategoryNode(activeNode))) {
      setActiveNodeId(main.id);
      return;
    }
    if (activeNodeId !== null) return;
    const center = chooseInitialCenter(nodes, edges);
    if (center) setActiveNodeId(center.id);
  }, [activeNodeId, nodes, edges]);

  useEffect(() => {
    if (activeNodeId && !isPresentationNodeId(activeNodeId) && !nodes.some(n => n.id === activeNodeId)) {
      setActiveNodeId(nodes[0]?.id ?? null);
    }
  }, [activeNodeId, nodes]);

  const presentationView = useMemo(() => {
    return buildPresentationView(nodesWithHighlight, edges, activeNodeId, showAllNodes, highlightedNodes);
  }, [nodesWithHighlight, edges, activeNodeId, showAllNodes, highlightedNodes]);

  // Sigma receives the raw graph (filtered by user-selected category/document/
  // importance). The smaller presentation view is retained only for metadata
  // lookups and panel behavior — panels still see the unfiltered graph.
  const filteredRendererGraph = useMemo(
    () => applyFilters(nodesWithHighlight, edges, filters),
    [nodesWithHighlight, edges, filters],
  );
  const hasRealMainEntity = useMemo(
    () => nodes.some(node => isMainEntityNode(node) && (node.data as GraphNodeData).provisional !== true),
    [nodes],
  );
  const suppressGraphUntilMainEntity = isProcessing && !hasRealMainEntity;
  const rendererSourceNodes = suppressGraphUntilMainEntity ? [] : filteredRendererGraph.nodes;
  const rendererSourceEdges = suppressGraphUntilMainEntity ? [] : filteredRendererGraph.edges;

  // Defer the array passed to the active renderer so React can interrupt paint
  // during rapid navigation or SSE bursts.
  const deferredNodes = useDeferredValue(rendererSourceNodes);
  const deferredEdges = useDeferredValue(rendererSourceEdges);
  const activeScopeNode = useMemo(() => {
    if (selectedNode) return selectedNode;
    if (!activeNodeId) return null;
    return nodes.find(node => node.id === activeNodeId)
      ?? presentationView.nodes.find(node => node.id === activeNodeId)
      ?? null;
  }, [activeNodeId, nodes, presentationView.nodes, selectedNode]);

  const handleSigmaNodeClick = useCallback((nodeId: string) => {
    const node = presentationView.nodes.find(item => item.id === nodeId)
      ?? nodes.find(item => item.id === nodeId);
    if (!node) return;
    handleNodeClick({} as React.MouseEvent, node);
  }, [handleNodeClick, nodes, presentationView.nodes]);

  const processingStatus = useMemo(() => {
    const recent = reasoningSteps.slice(-18);
    const last = recent[recent.length - 1];
    const branchStep = [...recent].reverse().find(step => /^Branch:\s*/i.test(step.text));
    const tripleStep = [...recent].reverse().find(step => /\b\d+\s+triple/i.test(step.text));
    const branch = branchStep?.text.replace(/^Branch:\s*/i, '').replace(/\s+-\s+\d+\s+chunk.*$/i, '').trim();
    const tripleMatch = tripleStep?.text.match(/\b(\d+)\s+triple/i);
    const phase = last?.text
      ? last.text.replace(/^(\[[^\]]+\]\s*)?/, '').trim()
      : 'Streaming graph updates';

    return {
      phase,
      branch,
      triples: tripleMatch?.[1],
      nodes: nodes.length,
      edges: edges.length,
      documents: dataSources.length,
    };
  }, [dataSources.length, edges.length, nodes.length, reasoningSteps]);

  return (
    <div className="w-screen h-screen relative overflow-hidden" style={{ background: 'var(--kg-canvas)' }}>
      <TopNav
        focusMode={focusMode}
        connectionMode={connectionMode}
        onToggleFocus={() => setFocusMode(f => !f)}
        onToggleConnection={() => setConnectionMode(c => !c)}
        onSearchOpen={() => setSearchOpen(true)}
        onFilterOpen={() => setFilterOpen(o => !o)}
        filterActive={hasActiveFilters(filters)}
        onUploadDocuments={handleUploadDocuments}
        graphLoaded={!isEmpty && !suppressGraphUntilMainEntity}
      />

      <GraphFilterPanel
        isOpen={filterOpen && !isEmpty}
        onClose={() => setFilterOpen(false)}
        nodes={nodes}
        edges={edges}
        filters={filters}
        onFiltersChange={setFilters}
        visibleCount={rendererSourceNodes.length}
        totalCount={nodes.length}
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

      <KnowledgeGraphRenderer
        nodes={deferredNodes}
        edges={deferredEdges}
        activeNodeId={activeNodeId}
        highlightedNodes={new Set([...highlightedNodes, ...aiHighlightedNodes])}
        sigmaViewMode="overview"
        onSigmaNodeClick={handleSigmaNodeClick}
        onSigmaFocusNodes={handleFocusMultiple}
        onPaneClick={handlePaneClick}
      />

      {/* Empty state blob */}
      {(isEmpty || isDissolving) && (
        <AnimatedBlob onDataSubmit={handleDataSubmit} isDissolving={isDissolving} />
      )}

      {/* Loading blob — only for the first graph build. Later uploads append in-place. */}
      <LoadingBlob isVisible={isProcessing && !hasRealMainEntity} reasoningSteps={reasoningSteps} />

      <AnimatePresence>
        {isProcessing && nodes.length > 0 && hasRealMainEntity && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed top-16 right-5 z-30 flex max-w-[min(360px,calc(100vw-40px))] items-center gap-3 rounded-xl px-3 py-2 text-xs"
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
            <span className="min-w-0">
              <span className="block truncate font-semibold">{processingStatus.phase}</span>
              <span className="block truncate opacity-70">
                {processingStatus.branch ? `${processingStatus.branch} · ` : ''}
                {processingStatus.nodes} nodes · {processingStatus.edges} edges
                {processingStatus.triples ? ` · ${processingStatus.triples} triples` : ''}
                {processingStatus.documents > 0 ? ` · ${processingStatus.documents} sources` : ''}
              </span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Node input box */}
      <AnimatePresence>
        {selectedNode && inputBoxPos && isRealDocumentNode(selectedNode) ? (
          <DocumentNodePanel
            title={(selectedNode.data as GraphNodeData).label}
            summary={
              typeof (selectedNode.data as GraphNodeData).summary === 'string'
                ? (selectedNode.data as GraphNodeData).summary as string
                : typeof (selectedNode.data as GraphNodeData).documentSummary === 'string'
                  ? (selectedNode.data as GraphNodeData).documentSummary as string
                  : undefined
            }
            sourceName={
              typeof (selectedNode.data as GraphNodeData).documentName === 'string'
                ? (selectedNode.data as GraphNodeData).documentName as string
                : undefined
            }
            category={
              typeof (selectedNode.data as GraphNodeData).category === 'string'
                ? (selectedNode.data as GraphNodeData).category as string
                : undefined
            }
            relationships={selectedNodeRelationships}
            position={inputBoxPos}
            onExpand={() => handleNodeAction('details', '')}
            onExpandSummary={() => openSummaryForNode(selectedNode)}
            onDelete={handleDeleteDocument}
            onClose={() => { setSelectedNode(null); setInputBoxPos(null); setSelectedNodeRelationships([]); setHighlightedNodes(new Set()); setNodes(nds => nds.map(n => ({ ...n, selected: false }))); }}
          />
        ) : selectedNode && inputBoxPos ? (
          <NodeInputBox
            nodeLabel={(selectedNode.data as GraphNodeData).label}
            entityType={(selectedNode.data as GraphNodeData).description}
            relationships={selectedNodeRelationships}
            position={inputBoxPos}
            onAction={handleNodeAction}
            onClose={() => { setSelectedNode(null); setInputBoxPos(null); setSelectedNodeRelationships([]); setHighlightedNodes(new Set()); setNodes(nds => nds.map(n => ({ ...n, selected: false }))); }}
            onDelete={
              !(selectedNode.data as GraphNodeData).isVirtualPresentation &&
              !isRealCategoryNode(selectedNode) &&
              (isRealDocumentNode(selectedNode) || (selectedNode.data as GraphNodeData).nodeType !== 'root')
                ? isRealDocumentNode(selectedNode) ? handleDeleteDocument : handleDeleteNode
                : undefined
            }
            onExpandSummary={isRealCategoryNode(selectedNode) || isRealDocumentNode(selectedNode) ? () => openSummaryForNode(selectedNode) : undefined}
            addedByAI={!!( selectedNode.data as Record<string, unknown>).parentId}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {summaryDetail && (
          <SummaryDetailPanel
            detail={summaryDetail}
            onClose={() => setSummaryDetail(null)}
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
        {!isEmpty && (
          <QueryBox
            onQuery={handleQuery}
            isQuerying={isQuerying}
            answer={queryAnswer}
            newNodesCount={queryNewNodesCount}
            onDismissAnswer={() => { setQueryAnswer(null); setQueryNewNodesCount(0); }}
            activeScopeLabel={activeScopeNode ? (activeScopeNode.data as GraphNodeData).label : undefined}
            activeScopeType={activeScopeNode ? (activeScopeNode.data as GraphNodeData).description : undefined}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export function KnowledgeGraphCanvas() {
  return <KnowledgeGraphCanvasInner />;
}
