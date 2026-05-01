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
import { GraphNodeMemo, type GraphNodeData } from './GraphNode';
import { NodeInputBox } from './NodeInputBox';
import { SidePanel } from './SidePanel';
import { TopNav } from './TopNav';
import { EdgeButton } from './EdgeButton';
import { FloatingEdge } from './FloatingEdge';
import type { AIReasoningStep, DataSource } from './types';

type GraphLayoutNode = Node<GraphNodeData>;

function forceDirectedLayout(layoutNodes: GraphLayoutNode[], layoutEdges: Edge[]): GraphLayoutNode[] {
  if (layoutNodes.length === 0) return layoutNodes;

  // Tuning constants
  const REPULSION = 18000;       // node-to-node repulsion strength
  const IDEAL_LENGTH = 210;      // preferred edge rest length (pixels)
  const STIFFNESS = 0.07;        // spring pull along each edge
  const DAMPING = 0.80;          // velocity decay per step
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
          // Jitter perfectly coincident nodes so they separate
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

// Deterministic pseudo-random based on index
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Sample graph generation from text
function generateGraphFromText(text: string): { nodes: Node[]; edges: Edge[]; reasoning: AIReasoningStep[] } {
  const words = text.split(/[\s,;.]+/).filter(w => w.length > 3);
  const topicWords = words.length >= 8 ? words.slice(0, 8) : [...words, 'Strategy', 'Growth', 'Systems', 'Analysis', 'Research', 'Markets', 'Design', 'Operations'].slice(0, 8);
  const topics = topicWords.slice(0, 8);
  const rootId = 'root';

  // Pre-supply measured dimensions so React Flow never re-measures nodes when
  // the compact flag changes (which would cause position/edge jumps).
  const nodeSizes: Record<string, { width: number; height: number }> = {
    root: { width: 180, height: 64 }, topic: { width: 150, height: 52 },
    subtopic: { width: 130, height: 46 }, detail: { width: 110, height: 40 },
  };

  const nodes: GraphLayoutNode[] = [
    {
      id: rootId,
      type: 'graphNode',
      position: { x: 0, y: 0 },
      data: { label: 'Company Data', description: 'Knowledge root', nodeType: 'root' } as GraphNodeData,
      measured: nodeSizes.root,
    },
  ];

  const edges: Edge[] = [];
  const reasoning: AIReasoningStep[] = [
    { id: 'r1', text: 'Analyzing input text for key concepts and entities...', timestamp: new Date(), type: 'analysis' },
  ];

  const angleStep = (2 * Math.PI) / topics.length;
  const baseRadius = 400;

  topics.forEach((topic, i) => {
    const angle = angleStep * i - Math.PI / 2;
    const topicId = `topic-${i}`;
    const topicRadius = baseRadius + (seededRandom(i * 7 + 3) - 0.5) * 80;
    nodes.push({
      id: topicId,
      type: 'graphNode',
      position: {
        x: Math.cos(angle) * topicRadius,
        y: Math.sin(angle) * topicRadius,
      },
      data: { label: topic.charAt(0).toUpperCase() + topic.slice(1), nodeType: 'topic' } as GraphNodeData,
      measured: nodeSizes.topic,
    });
    edges.push({
      id: `e-root-${topicId}`,
      source: rootId,
      target: topicId,
      type: 'floating',
    });
    reasoning.push({
      id: `r-${i + 2}`,
      text: `Identified "${topic}" as a key concept and connected to root.`,
      timestamp: new Date(),
      type: 'connection',
    });

    // Subtopics
    const subCount = Math.floor(Math.random() * 3) + 3;
    for (let j = 0; j < subCount; j++) {
      const sectorWidth = angleStep * 0.85;
      const subAngle = angle - sectorWidth / 2 + (sectorWidth / (subCount - 1 || 1)) * j;
      const subRadiusBase = topicRadius + 220 + (seededRandom(i * 13 + j * 17 + 5) - 0.5) * 60;
      const subId = `sub-${i}-${j}`;
      nodes.push({
        id: subId,
        type: 'graphNode',
        position: {
          x: Math.cos(subAngle) * subRadiusBase,
          y: Math.sin(subAngle) * subRadiusBase,
        },
        data: {
          label: `${topic.slice(0, 6)}-${j + 1}`,
          description: 'Related concept',
          nodeType: 'subtopic',
        } as GraphNodeData,
        measured: nodeSizes.subtopic,
      });
      edges.push({
        id: `e-${topicId}-${subId}`,
        source: topicId,
        target: subId,
        type: 'floating',
      });

      // Detail nodes (third level)
      const detailCount = Math.floor(Math.random() * 2) + 1;
      for (let k = 0; k < detailCount; k++) {
        const detailSpread = detailCount > 1 ? 0.3 : 0;
        const detailAngle = subAngle + (k - (detailCount - 1) / 2) * detailSpread;
        const detailRadius = subRadiusBase + 180 + (seededRandom(i * 23 + j * 31 + k * 41 + 9) - 0.5) * 50;
        const detailId = `detail-${i}-${j}-${k}`;
        nodes.push({
          id: detailId,
          type: 'graphNode',
          position: {
            x: Math.cos(detailAngle) * detailRadius,
            y: Math.sin(detailAngle) * detailRadius,
          },
          data: {
            label: `${topic.slice(0, 4)}-${j + 1}.${k + 1}`,
            description: 'Detail node',
            nodeType: 'detail' as const,
          } as GraphNodeData,
          measured: nodeSizes.detail,
        });
        edges.push({
          id: `e-${subId}-${detailId}`,
          source: subId,
          target: detailId,
          type: 'floating',
        });
      }
    }
  });

  reasoning.push({
    id: 'rfinal',
    text: `Generated ${nodes.length} nodes and ${edges.length} connections from the input data.`,
    timestamp: new Date(),
    type: 'analysis',
  });

  return { nodes: forceDirectedLayout(nodes, edges), edges, reasoning };
}

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
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [reasoningSteps, setReasoningSteps] = useState<AIReasoningStep[]>([]);
  const reactFlowInstance = useReactFlow();

  const nodeTypes = useMemo(() => ({ graphNode: GraphNodeMemo }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [expandedSubtree, setExpandedSubtree] = useState<Set<string>>(new Set());
  // Track full viewport so panning triggers the expand/compact logic too
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const viewportDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useOnViewportChange({
    onChange: useCallback((vp: { x: number; y: number; zoom: number }) => {
      setViewport(vp);
    }, []),
  });

  // Expand nodes visible in the current viewport, compact those that have panned out.
  // Debounced so mid-gesture frames don't trigger unnecessary state updates.
  useEffect(() => {
    if (nodes.length <= 50) return;

    if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);

    viewportDebounceRef.current = setTimeout(() => {
      if (viewport.zoom < 0.8) {
        setExpandedSubtree(prev => (prev.size > 0 ? new Set() : prev));
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

      // Replace (not merge) so nodes that pan off-screen compact back
      setExpandedSubtree(prev => {
        if (prev.size === visibleIds.size && [...visibleIds].every(id => prev.has(id))) return prev;
        return visibleIds;
      });
    }, 120);

    return () => { if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current); };
  }, [viewport, nodes]);

  const handleDataSubmit = useCallback((text: string) => {
    setIsDissolving(true);
    setDataSources(prev => [...prev, {
      id: `ds-${Date.now()}`,
      name: text.slice(0, 40) + (text.length > 40 ? '…' : ''),
      type: 'text',
      addedAt: new Date(),
    }]);

    setTimeout(() => {
      const { nodes: newNodes, edges: newEdges, reasoning } = generateGraphFromText(text);
      setNodes(newNodes);
      setEdges(newEdges);
      setReasoningSteps(reasoning);
      setIsEmpty(false);
      setIsDissolving(false);
    }, 900);
  }, [setNodes, setEdges]);

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

    // Find average direction of children to place input box on opposite side
    const childNodes = nodes.filter(n => childIds.has(n.id));
    const targetEl = ((_ as React.MouseEvent).currentTarget) as HTMLElement;
    const rect = targetEl.getBoundingClientRect();
    const boxWidth = 288; // w-72
    const boxHeight = 140;
    const nodeCenterX = rect.left + rect.width / 2;
    const nodeCenterY = rect.top + rect.height / 2;

    if (childNodes.length > 0 && reactFlowInstance) {
      // Calculate average child direction in screen space
      const viewport = reactFlowInstance.getViewport();
      let avgDx = 0, avgDy = 0;
      childNodes.forEach(c => {
        const screenX = c.position.x * viewport.zoom + viewport.x;
        const screenY = c.position.y * viewport.zoom + viewport.y;
        avgDx += screenX - (node.position.x * viewport.zoom + viewport.x);
        avgDy += screenY - (node.position.y * viewport.zoom + viewport.y);
      });
      avgDx /= childNodes.length;
      avgDy /= childNodes.length;

      // Place box on opposite side of children
      const absDx = Math.abs(avgDx);
      const absDy = Math.abs(avgDy);
      let posX: number, posY: number;

      if (absDy > absDx) {
        // Children are mostly above/below — place box on opposite vertical side
        posX = nodeCenterX - boxWidth / 2;
        posY = avgDy > 0 ? rect.top - boxHeight - 8 : rect.bottom + 8;
      } else {
        // Children are mostly left/right — place box on opposite horizontal side
        posY = nodeCenterY - boxHeight / 2;
        posX = avgDx > 0 ? rect.left - boxWidth - 8 : rect.right + 8;
      }

      // Clamp to viewport
      posX = Math.max(8, Math.min(window.innerWidth - boxWidth - 8, posX));
      posY = Math.max(8, Math.min(window.innerHeight - boxHeight - 8, posY));
      setInputBoxPos({ x: posX, y: posY });
    } else {
      // No children — default below
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

  const handleNodeAction = useCallback((action: string, prompt: string) => {
    if (!selectedNode) return;

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    const count = action === 'expand' ? 3 : action === 'research' ? 4 : 2;

    for (let i = 0; i < count; i++) {
      const id = `new-${Date.now()}-${i}`;
      const angle = (Math.PI * 2 / count) * i;
      newNodes.push({
        id,
        type: 'graphNode',
        position: {
          x: selectedNode.position.x + Math.cos(angle) * 180,
          y: selectedNode.position.y + Math.sin(angle) * 180 + 80,
        },
        data: {
          label: `${prompt.slice(0, 12)}-${i + 1}`,
          description: `AI-generated from ${action}`,
          nodeType: 'subtopic',
        } as GraphNodeData,
      });
      newEdges.push({
        id: `e-${selectedNode.id}-${id}`,
        source: selectedNode.id,
        target: id,
        type: 'floating',
      });
    }

    setNodes(prev => {
      const combined = [...prev, ...newNodes] as GraphLayoutNode[];
      const allEdges = [...edges, ...newEdges];
      return forceDirectedLayout(combined, allEdges);
    });
    setEdges(prev => [...prev, ...newEdges]);
    setReasoningSteps(prev => [...prev, {
      id: `r-${Date.now()}`,
      text: `${action}: "${prompt}" — generated ${count} new nodes from "${(selectedNode.data as GraphNodeData).label}".`,
      timestamp: new Date(),
      type: action === 'connect' ? 'connection' : 'expansion',
    }]);
    setSelectedNode(null);
    setInputBoxPos(null);
  }, [selectedNode, setNodes, setEdges]);

  const handleNodeFocus = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (node && reactFlowInstance) {
      // Collect node + children + grandchildren
      const ids = new Set<string>([nodeId]);
      const children = edges.filter(e => e.source === nodeId).map(e => e.target);
      children.forEach(cid => ids.add(cid));
      // Add grandchildren (children of children)
      children.forEach(cid => {
        edges.filter(e => e.source === cid).forEach(e => ids.add(e.target));
      });

      // Also collect all deeper descendants for expansion
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

      // Calculate bounding box of node + children + grandchildren
      const relevantNodes = nodes.filter(n => ids.has(n.id));
      if (relevantNodes.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        relevantNodes.forEach(n => {
          // Use expanded node size estimates for the bounding box
          minX = Math.min(minX, n.position.x - 120);
          minY = Math.min(minY, n.position.y - 60);
          maxX = Math.max(maxX, n.position.x + 240);
          maxY = Math.max(maxY, n.position.y + 100);
        });

        // Expand first, then fit bounds after nodes re-render
        setExpandedSubtree(allDescendants);
        setTimeout(() => {
          reactFlowInstance.fitBounds(
            { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
            { padding: 0.3, duration: 600 }
          );
        }, 50);
      } else {
        setExpandedSubtree(allDescendants);
      }
    }
  }, [nodes, edges, reactFlowInstance]);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setInputBoxPos(null);
    setHighlightedNodes(new Set());
    setExpandedSubtree(new Set());
  }, []);

  const nodesWithHighlight = useMemo(() => {
    const isCompact = nodes.length > 50;
    // Count children per node
    const childCount = new Map<string, number>();
    if (isCompact) {
      edges.forEach(e => childCount.set(e.source, (childCount.get(e.source) || 0) + 1));
    }
    return nodes.map(n => ({
      ...n,
      zIndex: expandedSubtree.has(n.id) ? 10 : 0,
      data: {
        ...n.data,
        isHighlighted: highlightedNodes.has(n.id),
        compact: isCompact && (n.data as GraphNodeData).nodeType !== 'root' && (childCount.get(n.id) || 0) < 3 && !expandedSubtree.has(n.id),
      },
    }));
  }, [nodes, edges, highlightedNodes, expandedSubtree]);

  return (
    <div className="w-screen h-screen relative overflow-hidden" style={{ background: 'var(--kg-canvas)' }}>
      <TopNav
        focusMode={focusMode}
        connectionMode={connectionMode}
        onToggleFocus={() => setFocusMode(f => !f)}
        onToggleConnection={() => setConnectionMode(c => !c)}
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
            position={inputBoxPos}
            onAction={handleNodeAction}
            onClose={() => { setSelectedNode(null); setInputBoxPos(null); }}
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