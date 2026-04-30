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

const typeStyles: Record<string, { size: string; fontClass: string; bg: string; glow: string; dot: string }> = {
  root: { size: 'min-w-[180px] px-5 py-4', fontClass: 'text-sm font-semibold', bg: 'var(--kg-node-root)', glow: 'var(--kg-glow-root)', dot: 'var(--kg-dot-root)' },
  topic: { size: 'min-w-[150px] px-4 py-3', fontClass: 'text-sm font-medium', bg: 'var(--kg-node-topic)', glow: 'var(--kg-glow-topic)', dot: 'var(--kg-dot-topic)' },
  subtopic: { size: 'min-w-[130px] px-3 py-2.5', fontClass: 'text-xs font-medium', bg: 'var(--kg-node-subtopic)', glow: 'var(--kg-glow-subtopic)', dot: 'var(--kg-dot-subtopic)' },
  detail: { size: 'min-w-[110px] px-3 py-2', fontClass: 'text-xs', bg: 'var(--kg-node-detail)', glow: 'var(--kg-glow-detail)', dot: 'var(--kg-dot-detail)' },
};

function GraphNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData;
  const style = typeStyles[nodeData.nodeType] || typeStyles.detail;
  const isHighlighted = nodeData.isHighlighted === true;
  const isCompact = nodeData.compact === true;
  const [hovered, setHovered] = useState(false);

  if (isCompact) {
    const dotSize = nodeData.nodeType === 'root' ? 36 : nodeData.nodeType === 'topic' ? 28 : 22;
    return (
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="cursor-pointer relative"
        style={{ width: dotSize, height: dotSize }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Handle type="target" position={Position.Top} className="!bg-transparent !w-1 !h-1 !border-none !top-0 !left-1/2 !-translate-x-1/2" />
        <Handle type="target" position={Position.Left} id="left-t" className="!bg-transparent !w-1 !h-1 !border-none !left-0 !top-1/2 !-translate-y-1/2" />
        <Handle type="target" position={Position.Right} id="right-t" className="!bg-transparent !w-1 !h-1 !border-none !right-0 !top-1/2 !-translate-y-1/2" />
        <div
          className="rounded-full w-full h-full"
          style={{
            background: style.dot,
            border: `2px solid ${selected ? 'var(--kg-node-active)' : isHighlighted ? 'oklch(0.75 0.18 250)' : 'var(--kg-node-border)'}`,
            boxShadow: selected
              ? '0 0 0 3px var(--kg-node-hover)'
              : isHighlighted
                ? `0 0 14px 6px oklch(0.7 0.18 250 / 50%), 0 0 4px 1px oklch(0.75 0.18 250 / 70%)`
                : `0 0 6px 2px ${style.glow}`,
            transform: isHighlighted ? 'scale(1.25)' : undefined,
            transition: 'transform 0.2s ease, box-shadow 0.2s ease, border 0.2s ease',
          }}
        />
        {hovered && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 rounded-xl px-3 py-2 pointer-events-none"
            style={{
              top: dotSize + 6,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
              backdropFilter: 'blur(16px)',
              whiteSpace: 'nowrap',
              minWidth: 100,
            }}
          >
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: style.dot }} />
              <span className="text-xs font-medium" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-display)' }}>
                {nodeData.label}
              </span>
            </div>
            {nodeData.description && (
              <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                {nodeData.description}
              </p>
            )}
          </motion.div>
        )}
        <Handle type="source" position={Position.Bottom} className="!bg-transparent !w-1 !h-1 !border-none !bottom-0 !left-1/2 !-translate-x-1/2" />
        <Handle type="source" position={Position.Left} id="left-s" className="!bg-transparent !w-1 !h-1 !border-none !left-0 !top-1/2 !-translate-y-1/2" />
        <Handle type="source" position={Position.Right} id="right-s" className="!bg-transparent !w-1 !h-1 !border-none !right-0 !top-1/2 !-translate-y-1/2" />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
       className={`rounded-2xl ${style.size} cursor-pointer`}
      style={{
        background: 'var(--kg-node-bg)',
        border: `1.5px solid ${selected ? 'var(--kg-node-active)' : 'var(--kg-node-border)'}`,
        boxShadow: selected
          ? '0 0 0 3px var(--kg-node-hover), var(--kg-shadow-md)'
          : isHighlighted
            ? `0 0 14px 5px oklch(0.75 0.15 250 / 25%), 0 0 0 1px oklch(0.6 0.15 250 / 50%), var(--kg-shadow-sm)`
            : `0 0 10px 3px ${style.glow}, var(--kg-shadow-sm)`,
      }}
      whileHover={{
        boxShadow: `0 0 16px 5px ${style.glow}, 0 4px 16px rgba(0,0,0,0.06)`,
        y: -1,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2 !border-none" />
      <Handle type="target" position={Position.Left} id="left-t" className="!bg-transparent !w-1 !h-1 !border-none" />
      <Handle type="target" position={Position.Right} id="right-t" className="!bg-transparent !w-1 !h-1 !border-none" />
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: style.dot }}
        />
        <span className={style.fontClass} style={{ color: 'var(--foreground)', fontFamily: 'var(--font-display)' }}>
          {nodeData.label}
        </span>
      </div>
      {nodeData.description && (
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
          {nodeData.description}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2 !border-none" />
      <Handle type="source" position={Position.Left} id="left-s" className="!bg-transparent !w-1 !h-1 !border-none" />
      <Handle type="source" position={Position.Right} id="right-s" className="!bg-transparent !w-1 !h-1 !border-none" />
    </motion.div>
  );
}

export const GraphNodeMemo = memo(GraphNodeComponent);