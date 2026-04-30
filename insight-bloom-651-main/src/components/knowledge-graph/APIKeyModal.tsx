import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { saveOpenAIKey } from '@/lib/api';

interface APIKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigured: () => void;
}

export function APIKeyModal({ isOpen, onClose, onConfigured }: APIKeyModalProps) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError('');
    try {
      await saveOpenAIKey(key.trim());
      onConfigured();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div
              className="pointer-events-auto w-[420px] rounded-2xl p-6 shadow-xl"
              style={{
                background: 'var(--kg-node-bg)',
                border: '1px solid var(--border)',
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}>
                  OpenAI API Key
                </h2>
                <button
                  onClick={onClose}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  ✕
                </button>
              </div>

              <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>
                Required for AI-powered entity extraction and graph expansion. Your key is stored in server memory only — never in the browser.
              </p>

              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="sk-..."
                autoFocus
                className="w-full rounded-xl px-4 py-3 text-sm mb-3 focus:outline-none"
                style={{
                  background: 'var(--secondary)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                  fontFamily: 'monospace',
                }}
              />

              {error && (
                <p className="text-xs mb-3" style={{ color: 'var(--destructive)' }}>
                  {error}
                </p>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl text-sm transition-colors hover:bg-accent"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={!key.trim() || saving}
                  className="px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                  style={{
                    background: 'var(--primary)',
                    color: 'var(--primary-foreground)',
                  }}
                >
                  {saving ? 'Verifying…' : 'Save & verify'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
