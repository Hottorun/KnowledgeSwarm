import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Node } from '@xyflow/react';
import type { GraphNodeData } from './GraphNode';

interface SearchResult {
  nodeId: string;
  label: string;
  entityType?: string;
  score: number;
}

function searchNodes(query: string, nodes: Node[]): SearchResult[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const tokens = q.split(/\s+/);
  const results: SearchResult[] = [];

  for (const node of nodes) {
    const data = node.data as GraphNodeData;
    const label = data.label.toLowerCase();
    const entityType = (data.description ?? '').toLowerCase();
    let score = 0;

    if (label === q)                                              score += 100;
    else if (label.startsWith(q))                                 score += 70;
    else if (label.includes(q))                                   score += 50;
    else if (tokens.every(t => label.includes(t)))                score += 40;
    else score += tokens.filter(t => label.includes(t)).length * 15;

    if (entityType === q)                                         score += 30;
    else if (entityType.includes(q))                              score += 20;
    else if (tokens.some(t => entityType.includes(t)))            score += 10;

    if (score > 0) results.push({ nodeId: node.id, label: data.label, entityType: data.description, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

interface GraphSearchPanelProps {
  nodes: Node[];
  isOpen: boolean;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onFocusMultiple: (nodeIds: string[]) => void;
}

export function GraphSearchPanel({ nodes, isOpen, onClose, onFocusNode, onFocusMultiple }: GraphSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setQuery('');
      setResults([]);
      setSearched(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); setSearched(false); return; }
    setResults(searchNodes(query, nodes));
    setSearched(true);
  }, [query, nodes]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (results.length === 1) { onFocusNode(results[0].nodeId); onClose(); }
    else if (results.length > 1) { onFocusMultiple(results.map(r => r.nodeId)); onClose(); }
  };

  const entityColors: Record<string, string> = {
    Company: 'oklch(0.72 0.10 250)', Organization: 'oklch(0.72 0.10 280)',
    Person: 'oklch(0.78 0.10 145)', Market: 'oklch(0.80 0.11 70)',
    Technology: 'oklch(0.74 0.10 310)', Product: 'oklch(0.78 0.10 0)',
    Event: 'oklch(0.82 0.11 95)', Location: 'oklch(0.78 0.09 195)',
  };
  const getDot = (type?: string) =>
    type ? (entityColors[type] ?? 'var(--primary)') : 'var(--primary)';

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40"
            onClick={onClose}
          />

          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed top-14 left-1/2 -translate-x-1/2 z-50 w-full"
            style={{ maxWidth: 520, padding: '0 16px' }}
          >
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: 'var(--kg-node-bg)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--kg-shadow-lg)',
              }}
            >
              {/* Input row */}
              <form onSubmit={handleSubmit} className="flex items-center gap-3 px-4 py-3">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>
                  <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Escape' && onClose()}
                  placeholder="Search nodes, topics, entities…"
                  className="flex-1 bg-transparent outline-none text-sm"
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="text-xs transition-colors hover:bg-accent rounded px-1.5 py-0.5"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    Clear
                  </button>
                )}
                <kbd
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', fontFamily: 'var(--font-body)' }}
                >
                  ESC
                </kbd>
              </form>

              {/* Results */}
              <AnimatePresence>
                {results.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.14 }}
                    style={{ borderTop: '1px solid var(--border)', maxHeight: 340, overflowY: 'auto' }}
                  >
                    {results.map((result) => (
                      <button
                        key={result.nodeId}
                        onClick={() => { onFocusNode(result.nodeId); onClose(); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                      >
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: getDot(result.entityType), flexShrink: 0 }} />
                        <span
                          className="flex-1 text-sm font-medium truncate"
                          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-display)' }}
                        >
                          {result.label}
                        </span>
                        {result.entityType && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wide shrink-0"
                            style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}
                          >
                            {result.entityType}
                          </span>
                        )}
                      </button>
                    ))}

                    {results.length > 1 && (
                      <button
                        onClick={() => { onFocusMultiple(results.map(r => r.nodeId)); onClose(); }}
                        className="w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                        style={{ borderTop: '1px solid var(--border)' }}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>
                          <circle cx="3" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                          <circle cx="8" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
                          <circle cx="13" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                          <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                          Show all {results.length} matches on the graph
                        </span>
                      </button>
                    )}
                  </motion.div>
                )}

                {searched && results.length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    className="px-4 py-6 text-center"
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                      No nodes match <span style={{ color: 'var(--foreground)', fontStyle: 'italic' }}>"{query}"</span>
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
