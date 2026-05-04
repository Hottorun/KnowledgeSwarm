import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadModal } from './UploadModal';

interface TopNavProps {
  focusMode: boolean;
  connectionMode: boolean;
  onToggleFocus: () => void;
  onToggleConnection: () => void;
  onSearchOpen: () => void;
  onFilterOpen: () => void;
  filterActive: boolean;
  onUploadDocuments: (files: File[]) => void;
  graphLoaded: boolean;
}

export function TopNav({ onSearchOpen, onFilterOpen, filterActive, onUploadDocuments, graphLoaded }: TopNavProps) {
  const [showProfile, setShowProfile] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <div className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-5 py-3">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full relative overflow-hidden flex-shrink-0">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: 'linear-gradient(135deg, var(--kg-blob-1), var(--kg-blob-2))',
              animation: 'blob-morph 6s ease-in-out infinite, blob-pulse 4s ease-in-out infinite',
              opacity: 0.9,
            }}
          />
          <div
            className="absolute inset-1 rounded-full"
            style={{
              background: 'linear-gradient(225deg, var(--kg-blob-2), var(--kg-blob-1))',
              animation: 'blob-morph 6s ease-in-out infinite reverse',
              opacity: 0.55,
            }}
          />
        </div>
        <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}>
          Mapify
        </span>
      </div>

      {/* Search + Upload + Profile */}
      <div className="flex items-center gap-2">
      {/* Search button — only when graph is loaded */}
      <AnimatePresence>
        {graphLoaded && (
          <>
          <motion.button
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18 }}
            onClick={onSearchOpen}
            className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-accent"
            style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
            title="Search graph (⌘K)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)' }}>
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </motion.button>
          <motion.button
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18 }}
            onClick={onFilterOpen}
            className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-accent relative"
            style={{
              background: filterActive ? 'var(--primary)' : 'var(--secondary)',
              border: '1px solid var(--border)',
              color: filterActive ? 'white' : 'var(--muted-foreground)',
            }}
            title="Filter graph"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 3.5h12L9.5 9v4L6.5 14V9L2 3.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            {filterActive && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                style={{ background: 'var(--destructive, #ef4444)', boxShadow: '0 0 0 1.5px var(--background)' }}
              />
            )}
          </motion.button>
          </>
        )}
      </AnimatePresence>

      {/* Upload documents button — only when graph is loaded */}
      <AnimatePresence>
        {graphLoaded && (
          <motion.button
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18 }}
            onClick={() => setUploadOpen(true)}
            className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-accent"
            style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
            title="Upload documents"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-foreground)' }}>
              <path d="M8 11V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M5 6L8 3L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 13H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      <UploadModal
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUpload={onUploadDocuments}
      />

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
    </div>
  );
}
