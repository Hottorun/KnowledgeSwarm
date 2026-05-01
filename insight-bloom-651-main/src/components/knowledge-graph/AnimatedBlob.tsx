import { motion, AnimatePresence } from 'framer-motion';
import { useState, useCallback, useRef } from 'react';
import type { AIReasoningStep } from './types';
import { checkMcpHealth, mcpReadAll, MCP_CONNECTOR_URL } from '@/lib/api';
import { extractFileText } from '@/lib/pdf';

const READABLE_EXTENSIONS = /\.(txt|md|csv|json|pdf)$/i;

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

type McpStatus = 'idle' | 'checking' | 'reading' | 'error';

export function AnimatedBlob({ onDataSubmit, isDissolving }: AnimatedBlobProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mcpServerUrl, setMcpServerUrl] = useState('');
  const [mcpStatus, setMcpStatus] = useState<McpStatus>('idle');
  const [mcpError, setMcpError] = useState('');

  const handleFiles = useCallback(async (files: File[]) => {
    const accepted = files.filter(f => READABLE_EXTENSIONS.test(f.name));
    if (accepted.length === 0) return;
    const contents = await Promise.all(accepted.map(async file => ({
      name: file.name,
      text: await extractFileText(file),
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

  const handleMcpConnect = useCallback(async () => {
    const serverUrl = mcpServerUrl.trim();
    if (!serverUrl) return;
    setMcpStatus('checking');
    setMcpError('');

    try {
      const healthCheck = await checkMcpHealth(serverUrl);
      if (!healthCheck.ok) {
        setMcpStatus('error');
        setMcpError(healthCheck.error || 'MCP bridge not reachable. Make sure the URL is correct and the server is running.');
        return;
      }

      setMcpStatus('reading');

      const text = await mcpReadAll(serverUrl);

      if (!text.trim()) {
        setMcpStatus('error');
        setMcpError('No readable files found (.txt, .md, .csv, .json).');
        return;
      }

      await onDataSubmit(text, 'MCP files');
    } catch (err) {
      setMcpStatus('error');
      const errorMsg = err instanceof Error ? err.message : 'Connection failed.';
      setMcpError(errorMsg);
      console.error('[MCP] Connection error:', err);
    }
  }, [mcpServerUrl, onDataSubmit]);

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
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); }}
      onDrop={handleDrop}
    >
      <div className="flex flex-col items-center gap-5">
        {/* Drop / click zone */}
        <div
          className="relative flex flex-col items-center cursor-pointer"
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
                    .pdf · .txt · .md · .csv · .json
                  </p>
                </motion.div>
              </div>
            </BlobShell>
          </motion.div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void handleFiles(files);
              e.target.value = '';
            }}
          />
        </div>

        {/* MCP connector panel */}
        <motion.div
          className="flex flex-col items-center gap-3 w-72"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.4 }}
        >
          {/* divider */}
          <div className="flex items-center gap-3 w-full">
            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>or connect via MCP</span>
            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
          </div>

          {/* MCP server URL input + connect button */}
          <div className="flex gap-2 w-full">
            <input
              type="url"
              value={mcpServerUrl}
              onChange={e => setMcpServerUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleMcpConnect(); }}
              placeholder="http://localhost:8790"
              className="flex-1 rounded-lg px-3 py-2 text-xs outline-none"
              style={{
                background: 'var(--secondary)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
              disabled={mcpStatus === 'checking' || mcpStatus === 'reading'}
            />
            <button
              onClick={() => void handleMcpConnect()}
              disabled={!mcpServerUrl.trim() || mcpStatus === 'checking' || mcpStatus === 'reading'}
              className="rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-foreground)',
                opacity: (!mcpServerUrl.trim() || mcpStatus === 'checking' || mcpStatus === 'reading') ? 0.5 : 1,
                cursor: (!mcpServerUrl.trim() || mcpStatus === 'checking' || mcpStatus === 'reading') ? 'not-allowed' : 'pointer',
              }}
            >
              {mcpStatus === 'checking' ? 'Checking…' : mcpStatus === 'reading' ? 'Reading…' : 'Connect'}
            </button>
          </div>

          {/* status / error */}
          <AnimatePresence mode="wait">
            {mcpStatus === 'error' && (
              <motion.p
                key="err"
                className="text-xs text-center"
                style={{ color: 'oklch(0.65 0.18 25)' }}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                {mcpError}
              </motion.p>
            )}
          </AnimatePresence>

          {/* download link */}
          <a
            href={MCP_CONNECTOR_URL}
            download
            className="text-xs transition-opacity hover:opacity-80"
            style={{ color: 'var(--muted-foreground)' }}
          >
            Download MCP connector ↓
          </a>
        </motion.div>
      </div>
    </motion.div>
  );
}

interface LoadingBlobProps {
  isVisible: boolean;
  reasoningSteps?: AIReasoningStep[];
}

export function LoadingBlob({ isVisible, reasoningSteps = [] }: LoadingBlobProps) {
  const lastStep = reasoningSteps[reasoningSteps.length - 1];

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
            <div className="relative z-10 text-center px-8 flex flex-col items-center gap-1">
              <motion.p
                className="text-sm font-semibold"
                style={{ color: 'white', textShadow: '0 1px 4px rgba(0,0,0,0.25)' }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                Building knowledge graph…
              </motion.p>
              <AnimatePresence mode="wait">
                {lastStep && (
                  <motion.p
                    key={lastStep.id}
                    className="text-xs font-semibold opacity-80"
                    style={{ color: 'white', textShadow: '0 1px 4px rgba(0,0,0,0.25)' }}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 0.8, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.3 }}
                  >
                    {lastStep.text}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </BlobShell>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
