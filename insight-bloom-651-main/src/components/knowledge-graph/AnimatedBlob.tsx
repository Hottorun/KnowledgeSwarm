import { motion } from 'framer-motion';
import { useState, useCallback } from 'react';

interface AnimatedBlobProps {
  onDataSubmit: (text: string) => void;
  isDissolving: boolean;
}

export function AnimatedBlob({ onDataSubmit, isDissolving }: AnimatedBlobProps) {
  const [inputText, setInputText] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const handleSubmit = useCallback(() => {
    if (inputText.trim()) {
      onDataSubmit(inputText.trim());
    }
  }, [inputText, onDataSubmit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      /\.(txt|md|csv|json)$/i.test(f.name)
    );
    if (files.length > 0) {
      const texts = await Promise.all(files.map(f => f.text()));
      onDataSubmit(texts.join('\n\n---\n\n'));
      return;
    }
    const text = e.dataTransfer.getData('text');
    if (text) onDataSubmit(text);
  }, [onDataSubmit]);

  if (isDissolving) {
    return (
      <motion.div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0, scale: 0.3, filter: 'blur(20px)' }}
        transition={{ duration: 0.8, ease: 'easeInOut' }}
      >
        <div
          className="w-72 h-72"
          style={{
            background: 'linear-gradient(135deg, var(--kg-blob-1), var(--kg-blob-2))',
            animation: 'blob-morph 6s ease-in-out infinite',
          }}
        />
      </motion.div>
    );
  }

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center z-10"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
    >
      <div
        className="relative flex flex-col items-center gap-8"
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        {/* Blob */}
        <motion.div
          className="relative w-72 h-72 flex items-center justify-center"
          animate={{ scale: isDragOver ? 1.1 : 1 }}
          transition={{ type: 'spring', stiffness: 200 }}
        >
          <div
            className="absolute inset-0 opacity-30"
            style={{
              background: 'linear-gradient(135deg, var(--kg-blob-1), var(--kg-blob-2))',
              animation: 'blob-morph 6s ease-in-out infinite, blob-pulse 4s ease-in-out infinite',
              filter: 'blur(40px)',
            }}
          />
          <div
            className="absolute inset-4"
            style={{
              background: 'linear-gradient(135deg, var(--kg-blob-1), var(--kg-blob-2))',
              animation: 'blob-morph 6s ease-in-out infinite reverse',
              opacity: 0.15,
              filter: 'blur(20px)',
            }}
          />
          <div className="relative text-center px-8 z-10">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
            >
              <p
                className="text-sm font-medium"
                style={{ color: 'var(--muted-foreground)' }}
              >
                Drop files or paste company data to begin
              </p>
            </motion.div>
          </div>
        </motion.div>

        {/* Input */}
        <motion.div
          className="w-full max-w-md"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.5 }}
        >
          <div
            className="relative rounded-2xl overflow-hidden transition-shadow duration-300"
            style={{
              background: 'var(--kg-node-bg)',
              border: `1px solid ${isFocused ? 'var(--kg-node-active)' : 'var(--kg-node-border)'}`,
              boxShadow: isFocused ? '0 0 0 3px var(--kg-node-hover), var(--kg-shadow-md)' : 'var(--kg-shadow-sm)',
            }}
          >
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={handleKeyDown}
              placeholder="Paste company data, org structure, or any text..."
              rows={3}
              className="w-full resize-none px-4 pt-4 pb-12 text-sm focus:outline-none"
              style={{
                background: 'transparent',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
              }}
            />
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                ⏎ to generate
              </span>
              <button
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 disabled:opacity-30"
                style={{
                  background: 'var(--primary)',
                  color: 'var(--primary-foreground)',
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}