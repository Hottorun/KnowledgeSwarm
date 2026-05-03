import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { FileText, Search, Trash2, X } from 'lucide-react';
import type { NodeRelationship } from './NodeInputBox';

interface DocumentNodePanelProps {
  title: string;
  summary?: string;
  sourceName?: string;
  category?: string;
  relationships: NodeRelationship[];
  position: { x: number; y: number };
  onExpand: () => void;
  onExpandSummary: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function cleanLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function DocumentNodePanel({
  title,
  summary,
  sourceName,
  category,
  relationships,
  position,
  onExpand,
  onExpandSummary,
  onDelete,
  onClose,
}: DocumentNodePanelProps) {
  const relationshipGroups = useMemo(() => {
    const topFacts = relationships
      .filter(rel => rel.predicate !== 'summary')
      .slice(0, 5);
    const relatedDocuments = relationships
      .filter(rel => /document|file|source/i.test(rel.otherLabel))
      .slice(0, 4);
    const relatedEntities = relationships
      .filter(rel => !/document|file|source/i.test(rel.otherLabel) && rel.predicate !== 'summary')
      .slice(0, 6);

    return { topFacts, relatedDocuments, relatedEntities };
  }, [relationships]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      transition={{ duration: 0.18 }}
      className="fixed z-50 w-[380px] max-w-[calc(100vw-32px)]"
      style={{ left: position.x, top: position.y }}
      data-input-box
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
        <div className="px-4 pt-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
            >
              <FileText size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
                Document
              </div>
              <div className="truncate text-sm font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
                {title}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {sourceName && <span>{sourceName}</span>}
                {category && <span>{cleanLabel(category)}</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
              aria-label="Close document panel"
            >
              <X size={14} />
            </button>
          </div>

          {summary && (
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              {summary}
            </p>
          )}
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-4 py-3">
          <Section title="Top facts" items={relationshipGroups.topFacts} />
          <Section title="Related entities" items={relationshipGroups.relatedEntities} />
          <Section title="Related documents" items={relationshipGroups.relatedDocuments} />
        </div>

        <div className="flex border-t" style={{ borderColor: 'var(--border)' }}>
          <button
            type="button"
            onClick={onExpandSummary}
            className="flex flex-1 items-center justify-center gap-2 px-3 py-3 text-xs font-semibold transition-colors hover:bg-accent"
            style={{ color: 'var(--foreground)' }}
          >
            <FileText size={14} />
            Expand Summary
          </button>
          <button
            type="button"
            onClick={onExpand}
            className="flex flex-1 items-center justify-center gap-2 px-3 py-3 text-xs font-semibold transition-colors hover:bg-accent"
            style={{ color: 'var(--foreground)', borderLeft: '1px solid var(--border)' }}
          >
            <Search size={14} />
            Research
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center justify-center gap-2 px-3 py-3 text-xs font-semibold transition-colors hover:bg-destructive/10"
            style={{ color: 'var(--destructive, #ef4444)', borderLeft: '1px solid var(--border)' }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function Section({ title, items }: { title: string; items: NodeRelationship[] }) {
  if (items.length === 0) return null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
        {title}
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div key={`${title}-${index}`} className="text-[11px] leading-snug">
            <span style={{ color: 'var(--muted-foreground)' }}>
              {item.direction === 'out' ? 'mentions' : cleanLabel(item.predicate) || 'connected from'}
            </span>
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>
              {' '}{item.otherLabel}
            </span>
            {item.sources?.[0] && (
              <div className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {item.sources[0].title || item.sources[0].url || item.sources[0].snippet}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
