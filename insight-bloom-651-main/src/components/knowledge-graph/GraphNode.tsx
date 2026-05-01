import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion } from 'framer-motion';

export interface GraphNodeData {
  label: string;
  description?: string;
  nodeType: 'root' | 'topic' | 'subtopic' | 'detail';
  isHighlighted?: boolean;
  compact?: boolean;
  [key: string]: unknown;
}

const typeStyles: Record<string, { fontClass: string; glow: string; dot: string }> = {
  root:     { fontClass: 'text-sm font-semibold', glow: 'var(--kg-glow-root)',     dot: 'var(--kg-dot-root)'     },
  topic:    { fontClass: 'text-sm font-medium',   glow: 'var(--kg-glow-topic)',    dot: 'var(--kg-dot-topic)'    },
  subtopic: { fontClass: 'text-xs font-medium',   glow: 'var(--kg-glow-subtopic)', dot: 'var(--kg-dot-subtopic)' },
  detail:   { fontClass: 'text-xs',               glow: 'var(--kg-glow-detail)',   dot: 'var(--kg-dot-detail)'   },
};

export const nodeDims: Record<string, { w: number; h: number; dot: number; px: number; py: number; r: string }> = {
  root:     { w: 180, h: 64, dot: 36, px: 20, py: 16, r: '1rem'    },
  topic:    { w: 150, h: 52, dot: 28, px: 16, py: 12, r: '1rem'    },
  subtopic: { w: 130, h: 46, dot: 22, px: 12, py: 10, r: '0.75rem' },
  detail:   { w: 110, h: 40, dot: 18, px: 12, py:  8, r: '0.75rem' },
};

export const charWidths: Record<string, number> = {
  root: 7.5, topic: 7, subtopic: 6.5, detail: 6,
};

export const LABEL_WRAP_AT = 25;

export function calcNodeDims(
  nodeType: string,
  label: string,
  description: string | undefined,
  hasAccent: boolean,
) {
  const base = nodeDims[nodeType] ?? nodeDims.detail;
  const charW = charWidths[nodeType] ?? 6;
  const lineH = nodeType === 'root' || nodeType === 'topic' ? 20 : 18;

  const labelLines = Math.ceil(label.length / LABEL_WRAP_AT);
  const effectiveLineChars = Math.min(label.length, LABEL_WRAP_AT);

  // Width: fit the longest line (capped at 25 chars), expand for short labels + optional badge
  const badgeW = hasAccent && description ? description.length * 5.5 + 20 : 0;
  const innerW = 16 + effectiveLineChars * charW + (badgeW > 0 ? 8 + badgeW : 0);
  const w = Math.max(base.w, Math.ceil(innerW + 2 * base.px));

  // Height: grow with label lines
  let h = Math.max(base.h, base.py * 2 + labelLines * lineH);

  // Description paragraph (no accent): grow height for wrapped lines
  if (description && !hasAccent) {
    const availW = w - 2 * base.px - 16;
    const charsPerLine = Math.max(Math.floor(availW / 5.5), 1);
    const extraLines = Math.max(0, Math.ceil(description.length / charsPerLine) - 1);
    h += extraLines * 18;
  }

  return { ...base, w, h };
}

// Entity type → accent color (dot, glow, subtle bg tint)
const entityAccent: Record<string, { dot: string; glow: string; tint: string }> = {
  Company:      { dot: '#3b82f6', glow: 'rgba(59,130,246,0.28)',  tint: 'rgba(59,130,246,0.07)' },
  Organization: { dot: '#6366f1', glow: 'rgba(99,102,241,0.28)',  tint: 'rgba(99,102,241,0.07)' },
  Person:       { dot: '#22c55e', glow: 'rgba(34,197,94,0.28)',   tint: 'rgba(34,197,94,0.07)'  },
  Market:       { dot: '#f97316', glow: 'rgba(249,115,22,0.28)',  tint: 'rgba(249,115,22,0.07)' },
  Technology:   { dot: '#a855f7', glow: 'rgba(168,85,247,0.28)',  tint: 'rgba(168,85,247,0.07)' },
  Product:      { dot: '#ec4899', glow: 'rgba(236,72,153,0.28)',  tint: 'rgba(236,72,153,0.07)' },
  Event:        { dot: '#eab308', glow: 'rgba(234,179,8,0.28)',   tint: 'rgba(234,179,8,0.07)'  },
  Location:     { dot: '#14b8a6', glow: 'rgba(20,184,166,0.28)',  tint: 'rgba(20,184,166,0.07)' },
  Regulation:   { dot: '#ef4444', glow: 'rgba(239,68,68,0.28)',   tint: 'rgba(239,68,68,0.07)'  },
  Concept:      { dot: '#94a3b8', glow: 'rgba(148,163,184,0.28)', tint: 'rgba(148,163,184,0.07)' },
  Topic:        { dot: '#94a3b8', glow: 'rgba(148,163,184,0.28)', tint: 'rgba(148,163,184,0.07)' },
};

function getAccent(description?: string) {
  if (!description) return null;
  const key = Object.keys(entityAccent).find(k => description.toLowerCase().includes(k.toLowerCase()));
  return key ? entityAccent[key] : null;
}

function GraphNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const style = typeStyles[nodeData.nodeType] || typeStyles.detail;
  const accent = getAccent(nodeData.description);
  const dims = calcNodeDims(nodeData.nodeType, nodeData.label, nodeData.description, !!accent);
  const dot = accent?.dot ?? style.dot;
  const glow = accent?.glow ?? style.glow;
  const tint = accent?.tint;
  const isHighlighted = nodeData.isHighlighted === true;
  const isCompact = nodeData.compact === true;
  const [hovered, setHovered] = useState(false);

  const cardBorder = selected
    ? 'var(--kg-node-active)'
    : isHighlighted
      ? 'oklch(0.6 0.15 250 / 80%)'
      : 'var(--kg-node-border)';

  const cardShadow = selected
    ? '0 0 0 3px var(--kg-node-hover), var(--kg-shadow-md)'
    : isHighlighted
      ? `0 0 14px 5px oklch(0.75 0.15 250 / 25%), 0 0 0 1px oklch(0.6 0.15 250 / 50%), var(--kg-shadow-sm)`
      : `0 0 10px 3px ${glow}, var(--kg-shadow-sm)`;

  const dotBorder = selected
    ? 'var(--kg-node-active)'
    : isHighlighted
      ? 'oklch(0.75 0.18 250)'
      : 'var(--kg-node-border)';

  const dotShadow = selected
    ? '0 0 0 3px var(--kg-node-hover)'
    : isHighlighted
      ? `0 0 14px 6px oklch(0.7 0.18 250 / 50%), 0 0 4px 1px oklch(0.75 0.18 250 / 70%)`
      : `0 0 6px 2px ${glow}`;

  return (
    <div
      // Fixed size — React Flow always measures this box regardless of which state is visible.
      style={{ width: dims.w, height: dims.h, position: 'relative', cursor: 'pointer' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top}   className="!bg-transparent !w-1 !h-1 !border-none !top-0 !left-1/2 !-translate-x-1/2" />
      <Handle type="target" position={Position.Left}  id="left-t"  className="!bg-transparent !w-1 !h-1 !border-none !left-0 !top-1/2 !-translate-y-1/2" />
      <Handle type="target" position={Position.Right} id="right-t" className="!bg-transparent !w-1 !h-1 !border-none !right-0 !top-1/2 !-translate-y-1/2" />

      {/* ── Compact dot ─────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: isCompact ? 1 : 0,
          transition: 'opacity 0.18s ease',
          pointerEvents: isCompact ? 'auto' : 'none',
        }}
      >
        <div
          style={{
            width: dims.dot, height: dims.dot,
            borderRadius: '50%',
            background: dot,
            border: `2px solid ${dotBorder}`,
            boxShadow: dotShadow,
            transform: isHighlighted ? 'scale(1.25)' : undefined,
            transition: 'transform 0.2s ease, box-shadow 0.2s ease',
          }}
        />

        {hovered && isCompact && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12 }}
            style={{
              position: 'absolute',
              top: dims.dot / 2 + 10,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 50,
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
              backdropFilter: 'blur(16px)',
              borderRadius: '0.75rem',
              padding: '6px 10px',
              whiteSpace: 'nowrap',
              minWidth: 100,
              pointerEvents: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              <span className={style.fontClass} style={{ color: 'var(--foreground)', fontFamily: 'var(--font-display)' }}>
                {nodeData.label}
              </span>
            </div>
            {nodeData.description && (
              <p className="mt-0.5 text-xs" style={{ color: dot, opacity: 0.8 }}>
                {nodeData.description}
              </p>
            )}
          </motion.div>
        )}
      </div>

      {/* ── Expanded card ───────────────────────────────────── */}
      <motion.div
        style={{
          position: 'absolute', inset: 0,
          paddingLeft: dims.px, paddingRight: dims.px,
          paddingTop: dims.py, paddingBottom: dims.py,
          borderRadius: dims.r,
          background: tint ? `linear-gradient(135deg, ${tint}, var(--kg-node-bg))` : 'var(--kg-node-bg)',
          border: `1.5px solid ${cardBorder}`,
          boxShadow: cardShadow,
          opacity: isCompact ? 0 : 1,
          transition: 'opacity 0.18s ease, box-shadow 0.2s ease, border 0.2s ease',
          pointerEvents: isCompact ? 'none' : 'auto',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}
        whileHover={isCompact ? {} : {
          boxShadow: `0 0 16px 5px ${glow}, 0 4px 16px rgba(0,0,0,0.06)`,
          y: -1,
        }}
      >
        <div style={{ display: 'flex', alignItems: nodeData.label.length > LABEL_WRAP_AT ? 'flex-start' : 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dot, marginTop: nodeData.label.length > LABEL_WRAP_AT ? 3 : 0 }} />
          <span
            className={style.fontClass}
            style={{
              color: 'var(--foreground)',
              fontFamily: 'var(--font-display)',
              maxWidth: `${LABEL_WRAP_AT}ch`,
              whiteSpace: 'normal',
              wordBreak: 'break-word',
              lineHeight: '1.4',
            }}
          >
            {nodeData.label}
          </span>
          {nodeData.description && accent && (
            <span
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
              style={{ background: `${dot}22`, color: dot }}
            >
              {nodeData.description}
            </span>
          )}
        </div>
        {nodeData.description && !accent && (
          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
            {nodeData.description}
          </p>
        )}
      </motion.div>

      <Handle type="source" position={Position.Bottom} className="!bg-transparent !w-1 !h-1 !border-none !bottom-0 !left-1/2 !-translate-x-1/2" />
      <Handle type="source" position={Position.Left}  id="left-s"  className="!bg-transparent !w-1 !h-1 !border-none !left-0 !top-1/2 !-translate-y-1/2" />
      <Handle type="source" position={Position.Right} id="right-s" className="!bg-transparent !w-1 !h-1 !border-none !right-0 !top-1/2 !-translate-y-1/2" />
    </div>
  );
}

export const GraphNodeMemo = memo(GraphNodeComponent);
