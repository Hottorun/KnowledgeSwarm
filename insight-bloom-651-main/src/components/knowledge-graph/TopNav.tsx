import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface TopNavProps {
  focusMode: boolean;
  connectionMode: boolean;
  onToggleFocus: () => void;
  onToggleConnection: () => void;
  onLoadSample?: () => void;
}

export function TopNav({ onLoadSample }: TopNavProps) {
  const [showProfile, setShowProfile] = useState(false);

  return (
    <div className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-5 py-3">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--foreground)' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="3" fill="var(--background)" />
            <circle cx="3" cy="4" r="1.5" fill="var(--background)" opacity="0.6" />
            <circle cx="13" cy="4" r="1.5" fill="var(--background)" opacity="0.6" />
            <circle cx="5" cy="13" r="1.5" fill="var(--background)" opacity="0.6" />
            <circle cx="12" cy="12" r="1.5" fill="var(--background)" opacity="0.6" />
            <line x1="8" y1="8" x2="3" y2="4" stroke="var(--background)" strokeWidth="0.5" opacity="0.4" />
            <line x1="8" y1="8" x2="13" y2="4" stroke="var(--background)" strokeWidth="0.5" opacity="0.4" />
            <line x1="8" y1="8" x2="5" y2="13" stroke="var(--background)" strokeWidth="0.5" opacity="0.4" />
            <line x1="8" y1="8" x2="12" y2="12" stroke="var(--background)" strokeWidth="0.5" opacity="0.4" />
          </svg>
        </div>
        <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}>
          KnowledgeGraph
        </span>
        {onLoadSample && (
          <button
            onClick={onLoadSample}
            className="ml-3 px-3 py-1 rounded-lg text-xs font-medium transition-colors hover:bg-accent"
            style={{ background: 'var(--secondary)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
          >
            Sample Data
          </button>
        )}
      </div>

      {/* Profile */}
      <div className="relative">
        <button
          onClick={() => setShowProfile(!showProfile)}
          className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-accent"
          style={{
            background: 'var(--secondary)',
            border: '1px solid var(--border)',
          }}
        >
          <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>U</span>
        </button>
        <AnimatePresence>
          {showProfile && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-11 w-44 rounded-xl overflow-hidden py-1"
              style={{
                background: 'var(--kg-node-bg)',
                border: '1px solid var(--border)',
                boxShadow: 'var(--kg-shadow-lg)',
              }}
            >
              {['Settings', 'Account', 'Logout'].map((item) => (
                <button
                  key={item}
                  className="w-full text-left px-4 py-2 text-sm transition-colors hover:bg-accent"
                  style={{ color: item === 'Logout' ? 'var(--destructive)' : 'var(--foreground)' }}
                >
                  {item}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
