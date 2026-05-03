import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { expandSubtree as apiExpandSubtree, type ExpandContext } from '@/lib/api';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';
import { isMainEntityNode, isRealCategoryNode, isRealDocumentNode } from './presentationGraph';
import type { AIReasoningStep } from './types';

function computeNodeDepth(nodeId: string, edgeList: GraphEdge[]): number {
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

export interface UseExpansionRefs {
  expansionAnchorRef: MutableRefObject<{ id: string; pos: { x: number; y: number } } | null>;
  expansionChildIdxRef: MutableRefObject<number>;
  expansionDepthRef: MutableRefObject<number>;
  expansionNewNodesRef: MutableRefObject<Set<string>>;
  expansionQueueRef: MutableRefObject<Array<() => Promise<void>>>;
  expansionRunningRef: MutableRefObject<boolean>;
}

export interface UseExpansionOptions {
  selectedNode: GraphNode | null;
  runId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  setReasoningSteps: Dispatch<SetStateAction<AIReasoningStep[]>>;
  setSelectedNode: Dispatch<SetStateAction<GraphNode | null>>;
  setInputBoxPos: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setExpandingNodeId: Dispatch<SetStateAction<string | null>>;
  setAiHighlightedNodes: Dispatch<SetStateAction<Set<string>>>;
  setQueuedExpansions: Dispatch<SetStateAction<number>>;
  pushHistory: () => void;
  refs: UseExpansionRefs;
}

export function useExpansion(opts: UseExpansionOptions) {
  const {
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
    refs,
  } = opts;
  const {
    expansionAnchorRef,
    expansionChildIdxRef,
    expansionDepthRef,
    expansionNewNodesRef,
    expansionQueueRef,
    expansionRunningRef,
  } = refs;

  const handleNodeAction = useCallback(async (action: string, prompt: string) => {
    if (!selectedNode) return;
    if ((selectedNode.data as GraphNodeData).isVirtualPresentation) {
      setReasoningSteps(prev => [...prev, {
        id: `virtual-${Date.now()}`,
        text: 'Select a concrete entity node before asking the swarm to expand it.',
        timestamp: new Date(),
        type: 'analysis',
      }]);
      return;
    }
    if (isRealCategoryNode(selectedNode)) {
      setReasoningSteps(prev => [...prev, {
        id: `presentation-${Date.now()}`,
        text: 'Select a document, concrete entity, or fact node before asking the swarm to expand it.',
        timestamp: new Date(),
        type: 'analysis',
      }]);
      return;
    }

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
    const getPredicate = (e: GraphEdge) =>
      (typeof e.label === 'string' && e.label ? e.label : (e.data as { predicate?: string })?.predicate) ?? 'related_to';

    // ── Build the focused-context bundle for the expansion router ─────────────
    // Pass 2 (parent routing) only sees what we send here, so a thin bundle
    // of `subtree ∪ ancestors` leaves the model with no candidates outside the
    // local chain — cross-connections to siblings, sister-documents, or the
    // main entity never get proposed. We expand the bundle with: main entity,
    // same-category siblings, same-document siblings, and globally top-importance
    // nodes. For small graphs (< 150 nodes) we just send everything.
    const FOCUSED_BUNDLE_FULL_GRAPH_THRESHOLD = 150;
    const SAME_CATEGORY_LIMIT = 12;
    const SAME_DOCUMENT_LIMIT = 12;
    const TOP_IMPORTANCE_LIMIT = 8;

    const importanceOf = (n: typeof nodes[number]) => {
      const v = (n.data as GraphNodeData).importance;
      return typeof v === 'number' ? v : 0;
    };

    const contextNodeIds = new Set<string>([
      ...subtreeIds,
      ...ancestorIds,
    ]);
    contextNodeIds.delete(selectedNodeId);

    if (nodes.length <= FOCUSED_BUNDLE_FULL_GRAPH_THRESHOLD) {
      for (const n of nodes) if (n.id !== selectedNodeId) contextNodeIds.add(n.id);
    } else {
      const selectedData = nodeData;
      const selectedCategory = (selectedData as GraphNodeData).category as string | undefined;
      const selectedDocument = (selectedData as GraphNodeData).documentName as string | undefined;

      // Always include the main entity — it's the structural anchor
      const mainEntity = nodes.find(isMainEntityNode);
      if (mainEntity && mainEntity.id !== selectedNodeId) contextNodeIds.add(mainEntity.id);

      // Same-category siblings (top by importance)
      if (selectedCategory) {
        nodes
          .filter(n => n.id !== selectedNodeId && (n.data as GraphNodeData).category === selectedCategory)
          .sort((a, b) => importanceOf(b) - importanceOf(a))
          .slice(0, SAME_CATEGORY_LIMIT)
          .forEach(n => contextNodeIds.add(n.id));
      }

      // Same-document siblings (top by importance)
      if (selectedDocument) {
        nodes
          .filter(n => n.id !== selectedNodeId && (n.data as GraphNodeData).documentName === selectedDocument)
          .sort((a, b) => importanceOf(b) - importanceOf(a))
          .slice(0, SAME_DOCUMENT_LIMIT)
          .forEach(n => contextNodeIds.add(n.id));
      }

      // Top-importance globally — catches the structural backbone
      nodes
        .filter(n => n.id !== selectedNodeId && importanceOf(n) > 0)
        .sort((a, b) => importanceOf(b) - importanceOf(a))
        .slice(0, TOP_IMPORTANCE_LIMIT)
        .forEach(n => contextNodeIds.add(n.id));
    }

    const contextNodes = [...contextNodeIds]
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is typeof nodes[number] => Boolean(n))
      .map(n => ({
        id: n.id,
        label: (n.data as GraphNodeData).label,
        type: (n.data as GraphNodeData).description ?? 'Entity',
      }));

    // Edges: any edge between two nodes in the bundle (or with the selected node)
    const contextEdges = edges
      .filter(e => {
        const sIn = contextNodeIds.has(e.source) || e.source === selectedNodeId;
        const tIn = contextNodeIds.has(e.target) || e.target === selectedNodeId;
        return sIn && tIn;
      })
      .map(e => ({
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
    const documentQuestion = `Go deeper into the document "${label}"${pathContext}. Extract additional important facts, risks, people, clauses, numbers, and relationships. Also find supported connections from this document to existing graph nodes, especially the main company, categories, related entities, and other documents. Prefer reusing existing node IDs when evidence supports it.`;

    const question = prompt
      ? `${prompt} — specifically about "${label}"${pathContext}`
      : isRealDocumentNode(selectedNode)
        ? documentQuestion
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
  }, [
    selectedNode,
    runId,
    nodes,
    edges,
    pushHistory,
    setReasoningSteps,
    setSelectedNode,
    setInputBoxPos,
    setExpandingNodeId,
    setAiHighlightedNodes,
    setQueuedExpansions,
    expansionAnchorRef,
    expansionChildIdxRef,
    expansionDepthRef,
    expansionNewNodesRef,
    expansionQueueRef,
    expansionRunningRef,
  ]);

  return { handleNodeAction };
}
