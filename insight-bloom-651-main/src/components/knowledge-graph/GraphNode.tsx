import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'framer-motion';

export interface GraphNodeData {
  label: string;
  description?: string;
  nodeType: 'root' | 'topic' | 'subtopic' | 'detail';
  isHighlighted?: boolean;
  compact?: boolean;
  animDelay?: number;
  isExpanding?: boolean;
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

// Soft pastel palette — high lightness, low chroma so colors feel calm.
// Order: deep enough for the dot, faded for the glow, barely-there for the bg tint.
interface AccentColor { dot: string; glow: string; tint: string; text: string }

const entityAccent: Record<string, AccentColor> = {
  Company:      { dot: 'oklch(0.72 0.10 250)', glow: 'oklch(0.72 0.10 250 / 22%)', tint: 'oklch(0.72 0.10 250 / 7%)',  text: 'oklch(0.45 0.12 250)' }, // soft blue
  Organization: { dot: 'oklch(0.72 0.10 280)', glow: 'oklch(0.72 0.10 280 / 22%)', tint: 'oklch(0.72 0.10 280 / 7%)',  text: 'oklch(0.45 0.12 280)' }, // soft indigo
  Person:       { dot: 'oklch(0.78 0.10 145)', glow: 'oklch(0.78 0.10 145 / 22%)', tint: 'oklch(0.78 0.10 145 / 7%)',  text: 'oklch(0.45 0.12 145)' }, // soft sage
  Market:       { dot: 'oklch(0.80 0.11 70)',  glow: 'oklch(0.80 0.11 70 / 22%)',  tint: 'oklch(0.80 0.11 70 / 7%)',   text: 'oklch(0.50 0.13 60)'  }, // soft amber
  Technology:   { dot: 'oklch(0.74 0.10 310)', glow: 'oklch(0.74 0.10 310 / 22%)', tint: 'oklch(0.74 0.10 310 / 7%)',  text: 'oklch(0.45 0.13 310)' }, // soft lavender
  Product:      { dot: 'oklch(0.78 0.10 0)',   glow: 'oklch(0.78 0.10 0 / 22%)',   tint: 'oklch(0.78 0.10 0 / 7%)',    text: 'oklch(0.50 0.13 5)'   }, // soft pink
  Event:        { dot: 'oklch(0.82 0.11 95)',  glow: 'oklch(0.82 0.11 95 / 22%)',  tint: 'oklch(0.82 0.11 95 / 7%)',   text: 'oklch(0.50 0.13 90)'  }, // soft yellow
  Location:     { dot: 'oklch(0.78 0.09 195)', glow: 'oklch(0.78 0.09 195 / 22%)', tint: 'oklch(0.78 0.09 195 / 7%)',  text: 'oklch(0.45 0.11 195)' }, // soft teal
  Regulation:   { dot: 'oklch(0.74 0.10 25)',  glow: 'oklch(0.74 0.10 25 / 22%)',  tint: 'oklch(0.74 0.10 25 / 7%)',   text: 'oklch(0.50 0.13 25)'  }, // soft coral
  Document:     { dot: 'oklch(0.76 0.06 230)', glow: 'oklch(0.76 0.06 230 / 22%)', tint: 'oklch(0.76 0.06 230 / 7%)',  text: 'oklch(0.45 0.08 230)' }, // soft slate-blue
  Concept:      { dot: 'oklch(0.74 0.04 260)', glow: 'oklch(0.74 0.04 260 / 22%)', tint: 'oklch(0.74 0.04 260 / 7%)',  text: 'oklch(0.45 0.05 260)' }, // soft slate
  Topic:        { dot: 'oklch(0.74 0.04 260)', glow: 'oklch(0.74 0.04 260 / 22%)', tint: 'oklch(0.74 0.04 260 / 7%)',  text: 'oklch(0.45 0.05 260)' },
  Entity:       { dot: 'oklch(0.74 0.04 260)', glow: 'oklch(0.74 0.04 260 / 22%)', tint: 'oklch(0.74 0.04 260 / 7%)',  text: 'oklch(0.45 0.05 260)' },
};

const fallbackAccent: AccentColor = entityAccent.Concept;

function getAccent(description?: string): AccentColor {
  if (!description) return fallbackAccent;
  const key = Object.keys(entityAccent).find(k => description.toLowerCase().includes(k.toLowerCase()));
  return key ? entityAccent[key] : fallbackAccent;
}

function GraphNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const isRoot = nodeData.nodeType === 'root';
  const style = typeStyles[nodeData.nodeType] || typeStyles.detail;
  const hasBadge = !!nodeData.description;
  const dims = calcNodeDims(nodeData.nodeType, nodeData.label, nodeData.description, hasBadge);
  const accent = getAccent(nodeData.description);
  const dot = accent.dot;
  const glow = accent.glow;
  const tint = accent.tint;
  const accentText = accent.text;
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

      <motion.div
        initial={{ opacity: 0, scale: isRoot ? 0.72 : 0.6, y: isRoot ? 0 : 8 }}
        animate={isRoot
          ? { opacity: 1, scale: [0.72, 1.12, 0.96, 1] as number[], y: 0 }
          : { opacity: 1, scale: 1, y: 0 }
        }
        transition={isRoot ? {
          opacity: { duration: 0.6, delay: 0 },
          scale: { duration: 1.8, delay: 0, times: [0, 0.42, 0.7, 1], ease: 'easeOut' },
          y: { duration: 0.7, delay: 0 },
        } : {
          duration: 1.4,
          delay: nodeData.animDelay ?? 0,
          ease: [0.34, 1.56, 0.64, 1],
        }}
        style={{ position: 'absolute', inset: 0 }}
      >

      {/* ── AI Working Blob ─────────────────────────────────── */}
      <AnimatePresence>
        {nodeData.isExpanding && (
          <motion.div
            key="expanding-blob"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              pointerEvents: 'none',
              background: 'transparent',
              borderRadius: dims.r,
              boxShadow: [
                `0 0 18px 8px ${dot.replace(')', ' / 50%)')}`,
                `0 0 40px 18px ${dot.replace(')', ' / 30%)')}`,
                `0 0 70px 30px ${dot.replace(')', ' / 15%)')}`,
              ].join(', '),
              animation: 'blob-pulse 2s ease-in-out infinite',
            }}
          />
        )}
      </AnimatePresence>

      {/* ── Compact dot ─────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 1,
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
          position: 'absolute', inset: 0, zIndex: 1,
          paddingLeft: dims.px, paddingRight: dims.px,
          paddingTop: dims.py, paddingBottom: dims.py,
          borderRadius: dims.r,
          background: `linear-gradient(135deg, ${tint}, var(--kg-node-bg))`,
          border: `1.5px solid ${cardBorder}`,
          boxShadow: cardShadow,
          opacity: isCompact ? 0 : 1,
          transition: 'opacity 0.18s ease, box-shadow 0.2s ease, border 0.2s ease',
          pointerEvents: isCompact ? 'none' : 'auto',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}
        whileHover={isCompact ? {} : {
          scale: 1.04,
          boxShadow: `0 0 18px 6px ${glow}, 0 6px 18px rgba(0,0,0,0.08)`,
          y: -2,
        }}
        transition={{ type: 'spring', stiffness: 380, damping: 26 }}
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
          {nodeData.description && (
            <span
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 uppercase tracking-wide"
              style={{
                background: tint,
                color: accentText,
                letterSpacing: '0.04em',
              }}
            >
              {nodeData.description}
            </span>
          )}
        </div>
      </motion.div>

      </motion.div>

      <Handle type="source" position={Position.Bottom} className="!bg-transparent !w-1 !h-1 !border-none !bottom-0 !left-1/2 !-translate-x-1/2" />
      <Handle type="source" position={Position.Left}  id="left-s"  className="!bg-transparent !w-1 !h-1 !border-none !left-0 !top-1/2 !-translate-y-1/2" />
      <Handle type="source" position={Position.Right} id="right-s" className="!bg-transparent !w-1 !h-1 !border-none !right-0 !top-1/2 !-translate-y-1/2" />
    </div>
  );
}

export const GraphNodeMemo = memo(GraphNodeComponent);
