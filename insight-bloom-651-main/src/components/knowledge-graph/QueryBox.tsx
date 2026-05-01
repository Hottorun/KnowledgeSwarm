import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface QueryBoxProps {
  onQuery: (question: string) => Promise<void>;
  isQuerying: boolean;
  answer: string | null;
  newNodesCount: number;
  onDismissAnswer: () => void;
}

export function QueryBox({ onQuery, isQuerying, answer, newNodesCount, onDismissAnswer }: QueryBoxProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const q = value.trim();
    if (!q || isQuerying) return;
    setValue('');
    onQuery(q);
  };

  // Focus input on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-3"
      style={{ width: 'min(600px, calc(100vw - 48px))' }}
    >
      {/* Answer bubble */}
      <AnimatePresence>
        {answer && (
          <motion.div
            key="answer"
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="w-full rounded-2xl p-4 relative"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
            }}
          >
            {newNodesCount > 0 && (
              <div
                className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-0.5 mb-2"
                style={{
                  background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
                  color: 'var(--primary)',
                  border: '1px solid color-mix(in oklch, var(--primary) 20%, transparent)',
                }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--primary)' }}
                />
                {newNodesCount} new connection{newNodesCount !== 1 ? 's' : ''} added to graph
              </div>
            )}
            <p className="text-sm leading-relaxed" style={{ color: 'var(--foreground)' }}>
              {answer}
            </p>
            <button
              onClick={onDismissAnswer}
              className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center opacity-40 hover:opacity-80 transition-opacity"
              style={{ color: 'var(--foreground)' }}
              aria-label="Dismiss"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input box */}
      <div
        className="w-full flex items-center gap-3 rounded-2xl px-4 py-3 transition-shadow"
        style={{
          background: 'var(--kg-node-bg)',
          border: '1px solid var(--kg-node-border)',
          boxShadow: 'var(--kg-shadow-md)',
        }}
      >
        {/* Icon */}
        <div className="shrink-0 opacity-40" style={{ color: 'var(--foreground)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>

        <input
          ref={inputRef}
          className="flex-1 bg-transparent outline-none text-sm"
          style={{
            color: 'var(--foreground)',
          }}
          placeholder={isQuerying ? 'Researching…' : 'Ask anything about your data…'}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
          disabled={isQuerying}
        />

        {/* Submit / spinner */}
        <motion.button
          onClick={handleSubmit}
          disabled={!value.trim() || isQuerying}
          whileTap={{ scale: 0.92 }}
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-opacity disabled:opacity-30"
          style={{
            background: 'var(--primary)',
            color: 'white',
          }}
          aria-label="Submit query"
        >
          <AnimatePresence mode="wait" initial={false}>
            {isQuerying ? (
              <motion.span
                key="spinner"
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: 0.15 }}
                className="flex items-center justify-center w-full h-full"
              >
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  className="block w-4 h-4 rounded-full"
                  style={{ borderTop: '2px solid white', borderRight: '2px solid transparent' }}
                />
              </motion.span>
            ) : (
              <motion.span
                key="arrow"
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: 0.15 }}
                className="flex items-center justify-center w-full h-full"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 7h10M7.5 2.5L12 7l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      {/* Hint */}
      <p className="text-xs opacity-30 pb-1" style={{ color: 'var(--foreground)' }}>
        Press Enter to research · new connections appear in graph
      </p>
    </motion.div>
  );
}
