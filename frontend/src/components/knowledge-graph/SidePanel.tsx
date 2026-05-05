import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AIReasoningStep } from './types';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';
import { describeNode, type NodeCategory } from '@/lib/api';

function isDocumentNode(node: GraphNode): boolean {
  const data = node.data as GraphNodeData;
  if (data.presentationRole === 'document') return true;
  const desc = String(data.description ?? '').toLowerCase();
  return desc === 'document';
}

function DocumentList({
  nodes,
  edges,
  onNodeFocus,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeFocus?: (nodeId: string) => void;
}) {
  // Old code (when documents were graph nodes) — keep for back-compat in
  // case the orchestrator ever re-emits them.
  const docNodes = nodes.filter(isDocumentNode);

  // New path: derive documents from edge sources. The orchestrator no
  // longer emits document nodes (the tree is main → category → entity),
  // but each `category → contains → entity` triple still carries its
  // source filename in `data.sources[0].title`. Surface those as a flat
  // list so the user can still see "what files built this graph".
  const docMap = new Map<string, { title: string; nodeIds: Set<string> }>();
  for (const edge of edges) {
    const sources = (edge.data as { sources?: Array<{ title?: string; url?: string }> } | undefined)?.sources ?? [];
    for (const source of sources) {
      const title = source.title || source.url;
      if (!title) continue;
      const entry = docMap.get(title) ?? { title, nodeIds: new Set<string>() };
      entry.nodeIds.add(edge.target);
      entry.nodeIds.add(edge.source);
      docMap.set(title, entry);
    }
  }
  const derivedDocs = [...docMap.values()];

  if (docNodes.length === 0 && derivedDocs.length === 0) return null;
  // When real document nodes exist, render those (legacy). Otherwise
  // render the derived list.
  if (docNodes.length === 0 && derivedDocs.length > 0) {
    return (
      <div className="mb-4">
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--muted-foreground)' }}
          >
            Documents
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
          >
            {derivedDocs.length}
          </span>
        </div>
        <div className="space-y-0.5">
          {derivedDocs.map(doc => (
            <button
              key={doc.title}
              onClick={() => {
                // Focus all nodes mentioned in this document by handing
                // off to onNodeFocus repeatedly — pick the first one as
                // the camera target since onNodeFocus is single-id.
                const first = [...doc.nodeIds][0];
                if (first) onNodeFocus?.(first);
              }}
              className="w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)' }}
              title={`${doc.nodeIds.size} entities mentioned`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>
                <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              <span className="text-xs truncate flex-1">{doc.title}</span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}
              >
                {doc.nodeIds.size}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const docs = docNodes;
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-2 mb-1.5">
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--muted-foreground)' }}
        >
          Documents
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
        >
          {docs.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {docs.map(doc => {
          const label = (doc.data as GraphNodeData).label;
          return (
            <button
              key={doc.id}
              onClick={() => onNodeFocus?.(doc.id)}
              className="w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)' }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>
                <path d="M3 2h7l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              <span className="flex-1 text-xs truncate" title={label}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CategoryList({
  categories,
  nodes,
  onFocusMultiple,
  onNodeFocus,
}: {
  categories: NodeCategory[];
  nodes: GraphNode[];
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

function LeftTabButton({
  active,
  onClick,
  label,
  badge,
  onDismiss,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  onDismiss?: () => void;
}) {
  return (
    <div
      className="flex items-center rounded-lg overflow-hidden text-xs transition-colors"
      style={{
        background: active ? 'var(--secondary)' : 'transparent',
        border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
      }}
    >
      <button
        onClick={onClick}
        className="px-3 py-1.5 font-medium transition-colors hover:bg-accent"
        style={{ color: active ? 'var(--foreground)' : 'var(--muted-foreground)' }}
      >
        {label}
        {badge !== undefined && (
          <span
            className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
            style={{
              background: active ? 'var(--background)' : 'var(--secondary)',
              color: 'var(--muted-foreground)',
              border: '1px solid var(--border)',
            }}
          >
            {badge}
          </span>
        )}
      </button>
      {onDismiss && active && (
        <button
          onClick={onDismiss}
          className="px-2 py-1.5 transition-colors hover:bg-accent"
          style={{ color: 'var(--muted-foreground)' }}
          title="Clear selection"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function SelectedNodeContent({
  node,
  onNodeFocus,
  onAction,
  onDelete,
}: {
  node: SelectedNodeInfo;
  onNodeFocus?: (id: string) => void;
  onAction?: (action: string, prompt: string) => void;
  onDelete?: () => void;
}) {
  const [aiDescription, setAiDescription] = useState<string | null>(null);
  const [descLoading, setDescLoading] = useState(true);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDescLoading(true);
    setAiDescription(null);
    describeNode(node.label, node.type ?? 'Entity', node.relationships).then(desc => {
      if (!cancelled) {
        setAiDescription(desc);
        setDescLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [node.id, node.label, node.type]);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {node.type && (
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {node.type}
              </div>
            )}
            <h2
              className="text-base font-semibold leading-tight break-words"
              style={{ color: 'var(--foreground)' }}
            >
              {node.label}
            </h2>
          </div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
              title="Delete node"
            >
              🗑
            </button>
          )}
        </div>
      </div>

      {/* AI summary */}
      <div>
        {descLoading ? (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-full animate-pulse"
              style={{ background: 'var(--kg-blob-1)' }}
            />
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              Generating summary…
            </span>
          </div>
        ) : aiDescription ? (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
            {aiDescription}
          </p>
        ) : node.description ? (
          <p className="text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
            {node.description}
          </p>
        ) : null}
      </div>

      {/* Ask input + expand actions */}
      {onAction && (
        <div className="space-y-2">
          <input
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onAction(prompt.trim() ? 'details' : 'categories', prompt.trim());
                setPrompt('');
              }
            }}
            placeholder="Ask a specific question about this node…"
            className="w-full rounded-lg px-3 py-2 text-xs outline-none transition-colors"
            style={{
              background: 'var(--secondary)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { onAction('categories', prompt.trim()); setPrompt(''); }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:bg-accent"
              style={{
                background: 'var(--secondary)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
              title="Broader sub-categories — keeps things abstract"
            >
              <span className="block font-semibold">🗂 Categories</span>
              <span className="block text-[10px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                Broad sub-categories
              </span>
            </button>
            <button
              onClick={() => { onAction('details', prompt.trim()); setPrompt(''); }}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:bg-accent"
              style={{
                background: 'var(--secondary)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
              title="Specific facts, names, numbers"
            >
              <span className="block font-semibold">🔬 Details</span>
              <span className="block text-[10px] mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                Specific facts
              </span>
            </button>
          </div>
        </div>
      )}

      {node.relationships.length > 0 && (
        <div>
          <div
            className="flex items-center justify-between mb-2 text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <span>Connections</span>
            <span
              className="px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
            >
              {node.relationships.length}
            </span>
          </div>
          <div className="space-y-2">
            {node.relationships.map((rel, i) => {
              const snippet = rel.sources?.find(source => source.snippet)?.snippet;
              const sourceLabel = rel.sources?.[0]?.title || rel.sources?.[0]?.url;
              const isOut = rel.direction === 'out';
              return (
                <div
                  key={i}
                  className="rounded-lg px-3 py-2 transition-colors hover:bg-accent cursor-pointer"
                  style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
                  onClick={() => rel.otherId && onNodeFocus?.(rel.otherId)}
                  title="Focus this connection"
                >
                  <div className="flex items-baseline gap-1.5 text-xs leading-snug">
                    {isOut ? (
                      <>
                        <span className="shrink-0 font-mono" style={{ color: 'var(--muted-foreground)', fontSize: 10 }}>→</span>
                        <span style={{ color: 'var(--muted-foreground)' }}>{rel.predicate}</span>
                        <span className="font-medium truncate" style={{ color: 'var(--foreground)' }}>{rel.otherLabel}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium truncate" style={{ color: 'var(--foreground)' }}>{rel.otherLabel}</span>
                        <span style={{ color: 'var(--muted-foreground)' }}>{rel.predicate}</span>
                        <span className="shrink-0 font-mono" style={{ color: 'var(--muted-foreground)', fontSize: 10 }}>→</span>
                      </>
                    )}
                  </div>
                  {snippet && (
                    <div
                      className="mt-1.5 italic line-clamp-2 text-[11px]"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      "{snippet}"
                    </div>
                  )}
                  {!snippet && sourceLabel && (
                    <div
                      className="mt-1.5 truncate text-[10px]"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {sourceLabel}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export interface SelectedNodeRelationship {
  direction: 'in' | 'out';
  predicate: string;
  otherId?: string;
  otherLabel: string;
  sources?: Array<{ title?: string; url?: string; snippet?: string }>;
}

export interface SelectedNodeInfo {
  id: string;
  label: string;
  type?: string;
  description?: string;
  relationships: SelectedNodeRelationship[];
}

interface SidePanelProps {
  side: 'left' | 'right';
  isOpen: boolean;
  onClose: () => void;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  onNodeFocus?: (nodeId: string) => void;
  onFocusMultiple?: (nodeIds: string[]) => void;
  categories?: NodeCategory[];
  reasoningSteps?: AIReasoningStep[];
  selectedNode?: SelectedNodeInfo | null;
  onSelectedNodeClose?: () => void;
  onSelectedNodeAction?: (action: string, prompt: string) => void;
  onSelectedNodeDelete?: () => void;
}

type LeftTab = 'contents' | 'documents' | 'selected';

export function SidePanel({ side, isOpen, onClose, nodes = [], edges = [], onNodeFocus, onFocusMultiple, categories = [], reasoningSteps = [], selectedNode = null, onSelectedNodeClose, onSelectedNodeAction, onSelectedNodeDelete }: SidePanelProps) {
  const isLeft = side === 'left';
  const reasoningBottomRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<LeftTab>('contents');

  // Whenever a new node is selected, snap to the Selected tab. Switching
  // back to Contents is a manual user action; we don't auto-switch on
  // deselect because that would yank focus away mid-read.
  useEffect(() => {
    if (selectedNode) setActiveTab('selected');
  }, [selectedNode?.id]);

  // Compute document count up-front so the Documents tab can show a badge
  // and we can hide it when there are zero documents. Mirrors the logic in
  // <DocumentList /> — derived from edge sources or document graph nodes.
  const documentCount = (() => {
    if (!isLeft) return 0;
    const docNodes = nodes.filter(isDocumentNode);
    if (docNodes.length > 0) return docNodes.length;
    const titles = new Set<string>();
    for (const edge of edges) {
      const sources = (edge.data as { sources?: Array<{ title?: string; url?: string }> } | undefined)?.sources ?? [];
      for (const source of sources) {
        const title = source.title || source.url;
        if (title) titles.add(title);
      }
    }
    return titles.size;
  })();

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
              {isLeft ? (activeTab === 'selected' && selectedNode ? 'Node Details' : 'Table of Contents') : 'AI Reasoning'}
            </h3>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
            >
              ✕
            </button>
          </div>

          {/* Tabs (left only, only when a node is selected) */}
          {isLeft && selectedNode && (
            <div
              className="flex items-center gap-1 px-3 py-2 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <LeftTabButton
                active={activeTab === 'contents'}
                onClick={() => setActiveTab('contents')}
                label="Contents"
              />
              <LeftTabButton
                active={activeTab === 'selected'}
                onClick={() => setActiveTab('selected')}
                label="Node"
                badge={selectedNode.relationships.length || undefined}
                onDismiss={onSelectedNodeClose}
              />
            </div>
          )}

          {/* Content */}
          <div className="p-5 overflow-y-auto" style={{ height: `calc(100% - ${isLeft && selectedNode ? 102 : 57}px)` }}>
            {isLeft ? (
              activeTab === 'selected' && selectedNode ? (
                <SelectedNodeContent
                  node={selectedNode}
                  onNodeFocus={onNodeFocus}
                  onAction={onSelectedNodeAction}
                  onDelete={onSelectedNodeDelete}
                />
              ) : (
                <>
                  <DocumentList nodes={nodes} edges={edges} onNodeFocus={onNodeFocus} />
                  {categories.length > 0 ? (
                    <CategoryList categories={categories} nodes={nodes} onFocusMultiple={onFocusMultiple} onNodeFocus={onNodeFocus} />
                  ) : tocRoots.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      Build a mind map to see its table of contents here.
                    </p>
                  ) : (
                    <TocTree roots={tocRoots} onNodeFocus={onNodeFocus} />
                  )}
                </>
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
