import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AIReasoningStep } from './types';
import type { Node, Edge } from '@xyflow/react';
import type { GraphNodeData } from './GraphNode';
import type { NodeCategory } from '@/lib/api';

function CategoryList({
  categories,
  nodes,
  onFocusMultiple,
  onNodeFocus,
}: {
  categories: NodeCategory[];
  nodes: Node[];
  onFocusMultiple?: (nodeIds: string[]) => void;
  onNodeFocus?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const toggle = (label: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="space-y-1">
      {categories.map(cat => {
        const validIds = cat.nodeIds.filter(id => nodeMap.has(id));
        const isOpen = expanded.has(cat.label);
        return (
          <div key={cat.label}>
            <div className="flex items-center gap-1">
              <button
                onClick={() => toggle(cat.label)}
                className="w-5 h-5 flex items-center justify-center shrink-0 rounded transition-colors hover:bg-accent"
                style={{ color: 'var(--muted-foreground)' }}
              >
                <svg
                  width="9" height="9" viewBox="0 0 10 10" fill="none"
                  style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                >
                  <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={() => validIds.length > 0 && onFocusMultiple?.(validIds)}
                className="flex-1 flex items-center gap-2 text-left rounded-lg px-2 py-1 transition-colors hover:bg-accent"
              >
                <span className="text-sm font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
                  {cat.label}
                </span>
                <span
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                  style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
                >
                  {validIds.length}
                </span>
              </button>
            </div>
            <AnimatePresence>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  {validIds.map(id => {
                    const n = nodeMap.get(id)!;
                    const label = (n.data as GraphNodeData).label;
                    return (
                      <div key={id} className="flex items-center" style={{ paddingLeft: 20 }}>
                        <span className="w-5 h-5 flex items-center justify-center shrink-0">
                          <span className="w-1 h-1 rounded-full" style={{ background: 'var(--muted-foreground)', opacity: 0.4 }} />
                        </span>
                        <button
                          onClick={() => onNodeFocus?.(id)}
                          className="flex-1 text-left rounded-lg px-2 py-1 text-xs transition-colors hover:bg-accent"
                          style={{ color: 'var(--muted-foreground)' }}
                        >
                          {label}
                        </button>
                      </div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

interface TocNode {
  id: string;
  label: string;
  children: TocNode[];
}

function TocItem({
  node,
  depth,
  expanded,
  onToggle,
  onNodeFocus,
}: {
  node: TocNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onNodeFocus?: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);

  const fontSizeClass = depth === 0 ? 'text-sm font-semibold' : depth === 1 ? 'text-xs font-medium' : 'text-xs';
  const colorStyle = depth === 0 ? 'var(--foreground)' : 'var(--muted-foreground)';
  const opacity = depth >= 2 ? 0.8 : 1;

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.id)}
            className="w-5 h-5 flex items-center justify-center shrink-0 rounded transition-colors hover:bg-accent"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <svg
              width="9" height="9" viewBox="0 0 10 10" fill="none"
              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
            >
              <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="w-5 h-5 flex items-center justify-center shrink-0">
            <span className="w-1 h-1 rounded-full" style={{ background: 'var(--muted-foreground)', opacity: 0.4 }} />
          </span>
        )}
        <button
          onClick={() => onNodeFocus?.(node.id)}
          className={`flex-1 text-left rounded-lg px-2 py-1 ${fontSizeClass} transition-colors hover:bg-accent`}
          style={{ color: colorStyle, opacity }}
        >
          {node.label}
        </button>
      </div>
      <AnimatePresence>
        {isExpanded && hasChildren && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            {node.children.map(child => (
              <TocItem
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onNodeFocus={onNodeFocus}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TocTree({ roots, onNodeFocus }: { roots: TocNode[]; onNodeFocus?: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      {roots.map(root => (
        <TocItem
          key={root.id}
          node={root}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          onNodeFocus={onNodeFocus}
        />
      ))}
    </div>
  );
}

interface SidePanelProps {
  side: 'left' | 'right';
  isOpen: boolean;
  onClose: () => void;
  nodes?: Node[];
  edges?: Edge[];
  onNodeFocus?: (nodeId: string) => void;
  onFocusMultiple?: (nodeIds: string[]) => void;
  categories?: NodeCategory[];
  reasoningSteps?: AIReasoningStep[];
}

export function SidePanel({ side, isOpen, onClose, nodes = [], edges = [], onNodeFocus, onFocusMultiple, categories = [], reasoningSteps = [] }: SidePanelProps) {
  const isLeft = side === 'left';
  const reasoningBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLeft && reasoningSteps.length > 0) {
      reasoningBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isLeft, reasoningSteps.length]);

  // Build TOC tree by traversing edges from root nodes
  const tocRoots = (() => {
    if (!isLeft || nodes.length === 0) return [];

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Build parent->children adjacency from edges
    const childrenMap = new Map<string, string[]>();
    const hasParent = new Set<string>();
    edges.forEach(e => {
      if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) return;
      const list = childrenMap.get(e.source) ?? [];
      list.push(e.target);
      childrenMap.set(e.source, list);
      hasParent.add(e.target);
    });

    // Recursively build TocNode tree, guarding against cycles
    const buildTree = (id: string, visited: Set<string>): TocNode => {
      const node = nodeMap.get(id)!;
      const childIds = childrenMap.get(id) ?? [];
      const children = childIds
        .filter(cid => !visited.has(cid))
        .map(cid => buildTree(cid, new Set([...visited, id])));
      return { id, label: (node.data as GraphNodeData).label, children };
    };

    // Start from nodes that have no parent (true roots in the graph)
    const roots = nodes.filter(n => !hasParent.has(n.id));
    // Fallback: if everything has a parent (cycle), use nodeType=root nodes
    const startNodes = roots.length > 0
      ? roots
      : nodes.filter(n => (n.data as GraphNodeData).nodeType === 'root');

    return startNodes.map(n => buildTree(n.id, new Set([n.id])));
  })();

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: isLeft ? -380 : 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: isLeft ? -380 : 380, opacity: 0 }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className={`fixed top-0 ${isLeft ? 'left-0' : 'right-0'} h-full w-[360px] z-40`}
          style={{
            background: 'var(--kg-panel-bg)',
            backdropFilter: 'blur(24px)',
            borderRight: isLeft ? '1px solid var(--border)' : 'none',
            borderLeft: isLeft ? 'none' : '1px solid var(--border)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
            <h3
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}
            >
              {isLeft ? 'Table of Contents' : 'AI Reasoning'}
            </h3>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
            >
              ✕
            </button>
          </div>

          {/* Content */}
          <div className="p-5 overflow-y-auto" style={{ height: 'calc(100% - 57px)' }}>
            {isLeft ? (
              categories.length > 0 ? (
                <CategoryList categories={categories} nodes={nodes} onFocusMultiple={onFocusMultiple} onNodeFocus={onNodeFocus} />
              ) : tocRoots.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Build a mind map to see its table of contents here.
                </p>
              ) : (
                <TocTree roots={tocRoots} onNodeFocus={onNodeFocus} />
              )
            ) : (
              reasoningSteps.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  AI reasoning will appear here as the graph is built.
                </p>
              ) : (
                <div className="space-y-3">
                  {reasoningSteps.map((step, idx) => (
                    <motion.div
                      key={step.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="rounded-xl px-4 py-3"
                      style={{
                        background: 'var(--secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: step.type === 'analysis' ? 'var(--kg-node-hover)' :
                                        step.type === 'connection' ? 'oklch(0.85 0.08 160 / 20%)' :
                                        'oklch(0.85 0.08 50 / 20%)',
                            color: step.type === 'analysis' ? 'var(--primary)' :
                                   step.type === 'connection' ? 'oklch(0.45 0.12 160)' :
                                   'oklch(0.45 0.12 50)',
                          }}
                        >
                          {step.type}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--foreground)' }}>
                        {step.text}
                      </p>
                    </motion.div>
                  ))}
                  <div ref={reasoningBottomRef} />
                </div>
              )
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}