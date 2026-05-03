import { motion } from 'framer-motion';
import { X } from 'lucide-react';

export interface SummaryDetail {
  title: string;
  type: string;
  summary?: string;
  documents: string[];
  entities: string[];
  facts: string[];
  risks: string[];
  sources: string[];
}

interface SummaryDetailPanelProps {
  detail: SummaryDetail;
  onClose: () => void;
}

export function SummaryDetailPanel({ detail, onClose }: SummaryDetailPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      style={{ background: 'color-mix(in oklch, var(--background) 72%, transparent)' }}
      onMouseDown={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.18 }}
        className="max-h-[82vh] w-full max-w-3xl overflow-hidden rounded-2xl"
        style={{
          background: 'var(--kg-node-bg)',
          border: '1px solid var(--kg-node-border)',
          boxShadow: 'var(--kg-shadow-lg)',
          backdropFilter: 'blur(20px)',
        }}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
              {detail.type}
            </div>
            <h2 className="truncate text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
              {detail.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent"
            style={{ color: 'var(--muted-foreground)' }}
            aria-label="Close summary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[calc(82vh-76px)] overflow-y-auto px-5 py-4">
          {detail.summary && (
            <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--foreground)' }}>
              {detail.summary}
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <SummaryList title="Documents" items={detail.documents} />
            <SummaryList title="Entities" items={detail.entities} />
            <SummaryList title="Top facts" items={detail.facts} wide />
            <SummaryList title="Risks / open questions" items={detail.risks} wide />
            <SummaryList title="Sources" items={detail.sources} wide />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SummaryList({ title, items, wide }: { title: string; items: string[]; wide?: boolean }) {
  if (items.length === 0) return null;

  return (
    <section className={wide ? 'md:col-span-2' : undefined}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
        {title}
      </h3>
      <div className="space-y-1.5">
        {items.map((item, index) => (
          <div
            key={`${title}-${index}`}
            className="rounded-lg px-3 py-2 text-xs leading-relaxed"
            style={{
              background: 'color-mix(in oklch, var(--muted) 42%, transparent)',
              color: 'var(--foreground)',
              border: '1px solid var(--border)',
            }}
          >
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}
