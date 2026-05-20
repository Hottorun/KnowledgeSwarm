import { lazy, Suspense, useState, useEffect } from 'react';
import type { GraphEdge, GraphNode } from './graphTypes';

const SigmaGraphView = lazy(() =>
  import('./SigmaGraphView').then((m) => ({ default: m.SigmaGraphView }))
);

interface KnowledgeGraphRendererProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodeId: string | null;
  highlightedNodes: Set<string>;
  sigmaViewMode: 'focused' | 'overview';
  isStreaming?: boolean;
  onSigmaNodeClick: (nodeId: string) => void;
  onSigmaFocusNodes: (nodeIds: string[]) => void;
  onPaneClick: () => void;
}

export function KnowledgeGraphRenderer({
  nodes,
  edges,
  activeNodeId,
  highlightedNodes,
  sigmaViewMode,
  isStreaming,
  onSigmaNodeClick,
  onSigmaFocusNodes,
  onPaneClick,
}: KnowledgeGraphRendererProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="w-full h-full" />;

  return (
    <Suspense fallback={<div className="w-full h-full" />}>
      <SigmaGraphView
        nodes={nodes}
        edges={edges}
        activeNodeId={activeNodeId}
        highlightedNodes={highlightedNodes}
        viewMode={sigmaViewMode}
        isStreaming={isStreaming}
        onNodeClick={onSigmaNodeClick}
        onFocusNodes={onSigmaFocusNodes}
        onPaneClick={onPaneClick}
      />
    </Suspense>
  );
}
