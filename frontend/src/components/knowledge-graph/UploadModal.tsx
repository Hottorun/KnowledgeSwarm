import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (files: File[]) => void;
}

const ACCEPTED = '.txt,.md,.csv,.json,.pdf';
const ACCEPTED_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf'];

function fileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}>
      <path d="M11 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-5-5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M11 2v5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function UploadModal({ isOpen, onClose, onUpload }: UploadModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const valid = Array.from(incoming).filter(
      f => ACCEPTED_TYPES.includes(f.type) || ACCEPTED.split(',').some(ext => f.name.endsWith(ext.replace('*', '')))
    );
    setFiles(prev => {
      const existingNames = new Set(prev.map(f => f.name));
      return [...prev, ...valid.filter(f => !existingNames.has(f.name))];
    });
  };

  const removeFile = (name: string) => setFiles(prev => prev.filter(f => f.name !== name));

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const handleSubmit = () => {
    if (files.length === 0) return;
    onUpload(files);
    setFiles([]);
    onClose();
  };

  const handleClose = () => {
    setFiles([]);
    onClose();
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
            onClick={handleClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div
              className="pointer-events-auto w-[460px] rounded-2xl p-6 shadow-xl"
              style={{ background: 'var(--kg-node-bg)', border: '1px solid var(--border)' }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}>
                  Upload Documents
                </h2>
                <button
                  onClick={handleClose}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  ✕
                </button>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl flex flex-col items-center justify-center gap-3 py-10 cursor-pointer transition-colors mb-4"
                style={{
                  border: `1.5px dashed ${dragging ? 'var(--primary)' : 'var(--border)'}`,
                  background: dragging ? 'var(--accent)' : 'var(--secondary)',
                }}
              >
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" style={{ color: 'var(--muted-foreground)' }}>
                  <path d="M14 18V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M10 12L14 8L18 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 22H23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <div className="text-center">
                  <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    Drag & drop files here
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    or click to browse — .txt, .md, .csv, .json, .pdf
                  </p>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED}
                className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />

              {/* File list */}
              {files.length > 0 && (
                <div className="mb-4 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                  {files.map(f => (
                    <div
                      key={f.name}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-xl"
                      style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
                    >
                      {fileIcon()}
                      <span className="text-xs flex-1 truncate" style={{ color: 'var(--foreground)' }}>{f.name}</span>
                      <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                        {f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFile(f.name); }}
                        className="w-5 h-5 rounded flex items-center justify-center text-xs transition-colors hover:bg-accent"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 rounded-xl text-sm transition-colors hover:bg-accent"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={files.length === 0}
                  className="px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                  style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  Upload {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
