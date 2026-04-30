import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';

interface NodeInputBoxProps {
  nodeLabel: string;
  position: { x: number; y: number };
  onAction: (action: string, prompt: string) => void;
  onClose: () => void;
}

export function NodeInputBox({ nodeLabel, position, onAction, onClose }: NodeInputBoxProps) {
  const [prompt, setPrompt] = useState('');
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (prompt.trim()) onAction('expand', prompt.trim());
    }
    if (e.key === 'Escape') onClose();
  }, [prompt, onAction, onClose]);

  const actions = [
    { key: 'expand', label: 'Expand', icon: '↗' },
    { key: 'research', label: 'Deep research', icon: '🔬' },
    { key: 'connect', label: 'Find connections', icon: '🔗' },
  ];

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
      transition={{ duration: 0.2 }}
      className="fixed z-50 w-72"
      style={{
        left: position.x + dragOffset.x,
        top: position.y + dragOffset.y,
        cursor: isDragging ? 'grabbing' : 'grab',
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
        <div className="px-3 pt-3 pb-2">
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>
            {nodeLabel}
          </p>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI to expand, analyze, or connect…"
            autoFocus
            className="w-full text-sm px-0 py-1 focus:outline-none"
            style={{
              background: 'transparent',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-body)',
            }}
          />
        </div>
        <div className="flex border-t" style={{ borderColor: 'var(--border)' }}>
          {actions.map((action) => (
            <button
              key={action.key}
              onClick={() => onAction(action.key, prompt || action.label)}
              className="flex-1 text-xs py-2.5 font-medium transition-colors duration-150 hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {action.icon} {action.label}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}