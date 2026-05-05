import { useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { describeNode } from '@/lib/api';

export interface NodeRelationship {
  direction: 'out' | 'in';
  predicate: string;
  otherId?: string;
  otherLabel: string;
  sources?: Array<{ title?: string; url?: string; snippet?: string }>;
}

interface NodeInputBoxProps {
  nodeLabel: string;
  entityType?: string;
  relationships?: NodeRelationship[];
  position: { x: number; y: number };
  onAction: (action: string, prompt: string) => void;
  onClose: () => void;
  onDelete?: () => void;
  onExpandSummary?: () => void;
  addedByAI?: boolean;
}

const actions = [
  {
    key: 'categories',
    label: 'Categories',
    icon: '🗂',
    hint: 'Broad sub-categories — keeps things abstract',
  },
  {
    key: 'details',
    label: 'Details',
    icon: '🔬',
    hint: 'Specific facts, names, numbers',
  },
];

export function NodeInputBox({ nodeLabel, entityType, relationships = [], position, onAction, onClose, onDelete, onExpandSummary, addedByAI }: NodeInputBoxProps) {
  const [prompt, setPrompt] = useState('');
  const [aiDescription, setAiDescription] = useState<string | null>(null);
  const [descLoading, setDescLoading] = useState(true);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    setDescLoading(true);
    setAiDescription(null);
    describeNode(nodeLabel, entityType ?? 'Entity', relationships).then(desc => {
      if (!cancelled) {
        setAiDescription(desc);
        setDescLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [nodeLabel, entityType, relationships]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Enter with text → ask question (uses details prompt path); empty → categories.
      onAction(prompt.trim() ? 'details' : 'categories', prompt.trim());
    }
    if (e.key === 'Escape') onClose();
  }, [prompt, onAction, onClose]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Walk up the DOM — clicks land on spans/icons inside buttons, so checking
    // tagName on e.target alone misses them and drag hijacks the click.
    const el = e.target as HTMLElement;
    if (el.closest('button, input, textarea, [data-no-drag]')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [dragOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !dragStart) return;
    setDragOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [isDragging, dragStart]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.18 }}
      className="fixed z-50 w-80"
      style={{
        left: position.x + dragOffset.x,
        top: position.y + dragOffset.y,
        cursor: isDragging ? 'grabbing' : 'default',
      }}
      data-input-box
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: 'var(--kg-node-bg)',
          border: '1px solid var(--kg-node-border)',
          boxShadow: 'var(--kg-shadow-lg)',
          backdropFilter: 'blur(20px)',
        }}
      >
        {/* Header — node identity */}
        <div className="px-4 pt-3 pb-2 cursor-grab" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                {entityType && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
                    {entityType}
                  </span>
                )}
                {addedByAI && (
                  <span
                    className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{ background: 'oklch(0.58 0.16 255 / 10%)', color: 'oklch(0.50 0.16 255)', border: '1px solid oklch(0.58 0.16 255 / 20%)' }}
                  >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0 L9.5 6 L16 8 L9.5 10 L8 16 L6.5 10 L0 8 L6.5 6 Z" />
                    </svg>
                    AI
                  </span>
                )}
              </div>
              <p className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--foreground)' }}>
                {nodeLabel}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {onDelete && (
                <button
                  onClick={onDelete}
                  title="Delete node and its children"
                  className="w-5 h-5 flex items-center justify-center rounded-full text-xs transition-colors hover:bg-destructive/20"
                  style={{ color: 'var(--destructive, #ef4444)' }}
                >
                  🗑
                </button>
              )}
              <button
                onClick={onClose}
                className="w-5 h-5 flex items-center justify-center rounded-full text-xs transition-colors hover:bg-accent"
                style={{ color: 'var(--muted-foreground)' }}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Relationships — every connection of this node, scrollable.
              Each row shows direction, predicate, other-end label, and the
              first source snippet inline so the popup actually answers
              "what is this node connected to and why" without an extra
              click into evidence. */}
          {relationships.length > 0 && (
            <div className="mt-2">
              <div
                className="flex items-center justify-between mb-1 text-[10px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--muted-foreground)' }}
              >
                <span>Connections</span>
                <span
                  className="px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
                >
                  {relationships.length}
                </span>
              </div>
              <div
                className="space-y-1.5 overflow-y-auto pr-1"
                style={{ maxHeight: 168 }}
              >
                {relationships.map((rel, i) => {
                  const snippet = rel.sources?.find(source => source.snippet)?.snippet;
                  const sourceLabel = rel.sources?.[0]?.title || rel.sources?.[0]?.url;
                  // Read order matches the actual triple direction. For
                  // outgoing edges (this → other), predicate first then
                  // other-end label. For incoming (other → this), the
                  // other-end label comes first so it reads naturally:
                  // "Grace Kim manages …" instead of "← manages Grace Kim".
                  const isOut = rel.direction === 'out';
                  return (
                    <div key={i} className="text-xs leading-snug">
                      <div className="flex items-baseline gap-1.5">
                        {isOut ? (
                          <>
                            <span className="shrink-0 font-mono" style={{ color: 'var(--muted-foreground)', fontSize: 10 }}>→</span>
                            <span style={{ color: 'var(--muted-foreground)' }}>{rel.predicate}</span>
                            <span className="font-medium truncate" style={{ color: 'var(--foreground)' }}>
                              "{rel.otherLabel}"
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="font-medium truncate" style={{ color: 'var(--foreground)' }}>
                              "{rel.otherLabel}"
                            </span>
                            <span style={{ color: 'var(--muted-foreground)' }}>{rel.predicate}</span>
                            <span className="shrink-0 font-mono" style={{ color: 'var(--muted-foreground)', fontSize: 10 }}>→</span>
                          </>
                        )}
                      </div>
                      {snippet && (
                        <div
                          className="ml-4 mt-0.5 italic line-clamp-2 text-[10.5px]"
                          style={{ color: 'var(--muted-foreground)' }}
                          title={snippet}
                        >
                          "{snippet}"
                        </div>
                      )}
                      {!snippet && sourceLabel && (
                        <div
                          className="ml-4 mt-0.5 truncate text-[10px]"
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

        {/* AI Description */}
        <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
          {descLoading ? (
            <div className="flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin" style={{ color: 'oklch(0.58 0.16 255)', flexShrink: 0 }}>
                <path d="M8 0 L9.5 6 L16 8 L9.5 10 L8 16 L6.5 10 L0 8 L6.5 6 Z" />
              </svg>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>Generating summary…</span>
            </div>
          ) : aiDescription != null ? (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              {aiDescription}
            </p>
          ) : null}
        </div>

        {/* Prompt input */}
        <div className="px-4 py-2.5">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a specific question about this node…"
            autoFocus
            className="w-full text-xs py-1 focus:outline-none"
            style={{
              background: 'transparent',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-body)',
            }}
          />
        </div>

        {/* Action buttons */}
        <div className="flex border-t" style={{ borderColor: 'var(--border)' }}>
          {onExpandSummary && (
            <button
              onClick={onExpandSummary}
              className="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 text-center transition-colors duration-150 hover:bg-accent"
              title="Open a larger source-backed summary panel"
            >
              <span className="text-base">▦</span>
              <span className="text-[11px] font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
                Summary
              </span>
              <span className="text-[9px] leading-tight px-1" style={{ color: 'var(--muted-foreground)' }}>
                Expand view
              </span>
            </button>
          )}
          {actions.map((action) => (
            <button
              key={action.key}
              onClick={() => onAction(action.key, prompt.trim())}
              className="flex-1 flex flex-col items-center gap-0.5 py-3 px-2 text-center transition-colors duration-150 hover:bg-accent"
              title={action.hint}
            >
              <span className="text-base">{action.icon}</span>
              <span className="text-[11px] font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
                {action.label}
              </span>
              <span className="text-[9px] leading-tight px-1" style={{ color: 'var(--muted-foreground)' }}>
                {action.hint.split('—')[0].trim()}
              </span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
