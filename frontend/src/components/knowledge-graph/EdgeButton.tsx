import { motion } from 'framer-motion';

interface EdgeButtonProps {
  side: 'left' | 'right';
  label: string;
  icon: string;
  onClick: () => void;
  isActive: boolean;
}

export function EdgeButton({ side, label, icon, onClick, isActive }: EdgeButtonProps) {
  return (
    <motion.button
      onClick={onClick}
      className={`fixed top-1/2 -translate-y-1/2 z-30 flex items-center gap-2 px-3 py-3 transition-all duration-200 ${side === 'left' ? 'left-0 rounded-r-2xl' : 'right-0 rounded-l-2xl'}`}
      style={{
        background: isActive ? 'var(--primary)' : 'var(--kg-node-bg)',
        color: isActive ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
        border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
        borderLeft: side === 'left' ? 'none' : undefined,
        borderRight: side === 'right' ? 'none' : undefined,
        boxShadow: 'var(--kg-shadow-md)',
      }}
      whileHover={{ x: side === 'left' ? 4 : -4 }}
      whileTap={{ scale: 0.95 }}
    >
      <span className="text-sm">{icon}</span>
      <span
        className="text-xs font-medium writing-vertical"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
      >
        {label}
      </span>
    </motion.button>
  );
}