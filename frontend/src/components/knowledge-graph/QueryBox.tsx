import { useState, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface QueryBoxProps {
  onQuery: (question: string) => Promise<void>;
  isQuerying: boolean;
  answer: string | null;
  newNodesCount: number;
  onDismissAnswer: () => void;
  activeScopeLabel?: string;
  activeScopeType?: string;
}

const shortcuts = [
  {
    label: 'Find connections',
    prompt: (scope: string) => `Find more connections for ${scope}. Use existing graph context first. Identify related documents, entities, risks, and unexplored links. Only use web search if local graph/files are insufficient.`,
  },
  {
    label: 'Find risks',
    prompt: (scope: string) => `Find risks, obligations, dependencies, and open questions for ${scope}. Add supported connections back to existing graph nodes where possible.`,
  },
  {
    label: 'Summarize branch',
    prompt: (scope: string) => `Summarize ${scope}. Include key facts, documents, entities, risks, opportunities, and source-backed open questions.`,
  },
  {
    label: 'Compare docs',
    prompt: (scope: string) => `Compare documents related to ${scope}. Find overlaps, contradictions, shared entities, and missing connections between documents.`,
  },
  {
    label: 'Key people',
    prompt: (scope: string) => `Find key people, roles, reporting lines, responsibilities, and people-related risks for ${scope}. Connect people to documents and business areas.`,
  },
  {
    label: 'Financial signals',
    prompt: (scope: string) => `Find financial signals for ${scope}, including revenue, costs, payments, margins, forecasts, exposure, and dated financial facts.`,
  },
  {
    label: 'Legal obligations',
    prompt: (scope: string) => `Find legal obligations for ${scope}, including contracts, parties, jurisdiction, confidentiality, termination, compliance, and licensing relationships.`,
  },
];

export function QueryBox({
  onQuery,
  isQuerying,
  answer,
  newNodesCount,
  onDismissAnswer,
  activeScopeLabel,
  activeScopeType,
}: QueryBoxProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scope = activeScopeLabel
    ? `the active ${activeScopeType ? activeScopeType.toLowerCase() : 'node'} "${activeScopeLabel}"`
    : 'the current graph';

  const handleSubmit = () => {
    const q = value.trim();
    if (!q || isQuerying) return;
    setValue('');
    onQuery(q);
  };

  const handleShortcut = (prompt: string) => {
    if (isQuerying) return;
    setValue('');
    onQuery(prompt);
  };

  // Show chips when the user is engaged with the input (focused, typing,
  // or anchored to a specific scope) — otherwise they just occlude the graph.
  const chipsVisible = focused || value.length > 0 || Boolean(activeScopeLabel && answer);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-4 pb-4 pt-2"
      style={{
        pointerEvents: 'none',
      }}
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
            className="w-[min(560px,calc(100vw-48px))] rounded-2xl p-4 relative"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--kg-node-border)',
              boxShadow: 'var(--kg-shadow-md)',
              pointerEvents: 'auto',
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

      <AnimatePresence>
        {chipsVisible && (
          <motion.div
            key="chips"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            className="flex w-[min(760px,calc(100vw-48px))] items-center justify-start gap-1.5 overflow-x-auto pb-1"
            style={{ pointerEvents: 'auto' }}
          >
            {shortcuts.slice(0, activeScopeLabel ? 7 : 4).map(shortcut => (
              <button
                key={shortcut.label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleShortcut(shortcut.prompt(scope))}
                disabled={isQuerying}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 hover:bg-accent"
                style={{
                  background: 'var(--kg-node-bg)',
                  border: '1px solid var(--kg-node-border)',
                  color: 'var(--muted-foreground)',
                  boxShadow: 'var(--kg-shadow-sm)',
                }}
              >
                {shortcut.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input box */}
      <div
        className="flex w-[min(560px,calc(100vw-48px))] items-center gap-3 rounded-2xl px-4 py-3 transition-shadow"
        style={{
          background: 'var(--kg-node-bg)',
          border: '1px solid var(--kg-node-border)',
          boxShadow: 'var(--kg-shadow-md)',
          pointerEvents: 'auto',
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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

    </motion.div>
  );
}
