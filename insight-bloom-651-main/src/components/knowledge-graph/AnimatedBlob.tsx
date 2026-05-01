import { motion, AnimatePresence } from 'framer-motion';
import { useState, useCallback, useRef } from 'react';

interface AnimatedBlobProps {
  onDataSubmit: (text: string, documentName?: string) => void | Promise<void>;
  isDissolving: boolean;
}

function BlobShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative w-72 h-72 flex items-center justify-center">
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, var(--kg-blob-1), var(--kg-blob-2))',
          animation: 'blob-morph 6s ease-in-out infinite, blob-pulse 4s ease-in-out infinite',
          opacity: 0.85,
          filter: 'blur(6px)',
        }}
      />
      <div
        className="absolute inset-4"
        style={{
          background: 'linear-gradient(225deg, var(--kg-blob-2), var(--kg-blob-1))',
          animation: 'blob-morph 6s ease-in-out infinite reverse',
          opacity: 0.6,
          filter: 'blur(2px)',
        }}
      />
      {children}
    </div>
  );
}

export function AnimatedBlob({ onDataSubmit, isDissolving }: AnimatedBlobProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    const accepted = files.filter(f => /\.(txt|md|csv|json)$/i.test(f.name));
    if (accepted.length === 0) return;
    const contents = await Promise.all(accepted.map(async file => ({
      name: file.name,
      text: await file.text(),
    })));
    await onDataSubmit(
      contents.map(file => `--- ${file.name} ---\n${file.text}`).join('\n\n'),
      contents.map(file => file.name).join(', '),
    );
  }, [onDataSubmit]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await handleFiles(files);
      return;
    }
    const text = e.dataTransfer.getData('text');
    if (text) {
      await onDataSubmit(text);
    }
  }, [handleFiles, onDataSubmit]);

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
        className="relative flex flex-col items-center gap-6 cursor-pointer"
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <motion.div
          animate={{ scale: isDragOver ? 1.1 : 1 }}
          transition={{ type: 'spring', stiffness: 200 }}
        >
          <BlobShell>
            <div className="relative text-center px-8 z-10">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.5 }}
              >
                <p
                  className="text-sm font-semibold"
                  style={{ color: 'white', textShadow: '0 1px 4px rgba(0,0,0,0.25)' }}
                >
                  {isDragOver ? 'Drop to begin' : 'Drop or click to add files'}
                </p>
                <p
                  className="text-xs mt-1 opacity-80"
                  style={{ color: 'white', textShadow: '0 1px 3px rgba(0,0,0,0.25)' }}
                >
                  .txt · .md · .csv · .json
                </p>
              </motion.div>
            </div>
          </BlobShell>
        </motion.div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void handleFiles(files);
            e.target.value = '';
          }}
        />
      </div>
    </motion.div>
  );
}

interface LoadingBlobProps {
  isVisible: boolean;
}

export function LoadingBlob({ isVisible }: LoadingBlobProps) {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <BlobShell>
            <motion.p
              className="relative z-10 text-sm font-semibold"
              style={{ color: 'white', textShadow: '0 1px 4px rgba(0,0,0,0.25)' }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.4 }}
            >
              Building knowledge graph…
            </motion.p>
          </BlobShell>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
