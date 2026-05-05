import { SigmaGraphView } from './SigmaGraphView';
import type { GraphEdge, GraphNode } from './graphTypes';

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
  return (
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
  );
}
