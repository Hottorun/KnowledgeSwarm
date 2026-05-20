import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createProject, listProjects, type Project } from '@/lib/api';

interface ProjectPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProject: Project | null;
  onSelectProject: (project: Project) => void;
  onGenerateFullMap: (project: Project) => void;
  onGenerateCustomMap: (project: Project, prompt: string) => void;
  isGenerating: boolean;
}

export function ProjectPickerModal({
  isOpen,
  onClose,
  currentProject,
  onSelectProject,
  onGenerateFullMap,
  onGenerateCustomMap,
  isGenerating,
}: ProjectPickerModalProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Project | null>(currentProject);
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [mode, setMode] = useState<'full' | 'custom'>('full');
  const newNameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(currentProject);
    setLoading(true);
    listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, [isOpen, currentProject]);

  useEffect(() => {
    if (showCreate) setTimeout(() => newNameRef.current?.focus(), 50);
  }, [showCreate]);

  useEffect(() => {
    if (mode === 'custom') setTimeout(() => promptRef.current?.focus(), 50);
  }, [mode]);

  const handleCreate = async () => {
    if (!newName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const project = await createProject(newName.trim());
      setProjects(prev => [project, ...prev]);
      setSelected(project);
      onSelectProject(project);
      setNewName('');
      setShowCreate(false);
    } catch {
      // ignore
    } finally {
      setIsCreating(false);
    }
  };

  const handleGenerate = () => {
    if (!selected || isGenerating) return;
    if (mode === 'full') {
      onGenerateFullMap(selected);
    } else {
      if (!customPrompt.trim()) return;
      onGenerateCustomMap(selected, customPrompt.trim());
    }
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />

          {/* Modal card */}
          <motion.div
            className="fixed z-50 left-1/2 top-1/2 w-full max-w-md"
            style={{ translateX: '-50%', translateY: '-50%' }}
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <div
              className="rounded-2xl overflow-hidden flex flex-col"
              style={{
                background: 'var(--kg-node-bg)',
                border: '1px solid var(--kg-node-border)',
                boxShadow: 'var(--kg-shadow-md)',
                maxHeight: '85vh',
              }}
            >
              {/* Header */}
              <div
                className="flex items-center justify-between px-5 py-4"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                  Projects
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowCreate(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{
                      background: showCreate ? 'var(--primary)' : 'var(--secondary)',
                      color: showCreate ? 'var(--primary-foreground)' : 'var(--foreground)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <span>{showCreate ? '×' : '+'}</span>
                    New project
                  </button>
                  <button
                    onClick={onClose}
                    className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-accent"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* New project input */}
              <AnimatePresence>
                {showCreate && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    <div className="flex gap-2 px-5 py-3">
                      <input
                        ref={newNameRef}
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
                        placeholder="Project name…"
                        className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                        style={{
                          background: 'var(--secondary)',
                          border: '1px solid var(--border)',
                          color: 'var(--foreground)',
                        }}
                      />
                      <button
                        onClick={handleCreate}
                        disabled={!newName.trim() || isCreating}
                        className="px-4 py-2 rounded-lg text-xs font-semibold transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                      >
                        {isCreating ? '…' : 'Create'}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Project list */}
              <div className="overflow-y-auto flex-1" style={{ minHeight: 120, maxHeight: 260 }}>
                {loading ? (
                  <div className="flex items-center justify-center py-10 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    Loading…
                  </div>
                ) : projects.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-1">
                    <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>No projects yet</span>
                    <span className="text-xs opacity-60" style={{ color: 'var(--muted-foreground)' }}>Create one above to get started</span>
                  </div>
                ) : (
                  <div className="p-2 flex flex-col gap-1">
                    {projects.map(project => {
                      const isActive = selected?.id === project.id;
                      return (
                        <button
                          key={project.id}
                          onClick={() => { setSelected(project); onSelectProject(project); }}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all"
                          style={{
                            background: isActive ? 'var(--primary)' : 'transparent',
                            color: isActive ? 'var(--primary-foreground)' : 'var(--foreground)',
                          }}
                        >
                          {/* folder icon */}
                          <svg
                            width="16" height="16" viewBox="0 0 16 16" fill="none"
                            style={{ flexShrink: 0, opacity: isActive ? 0.9 : 0.5 }}
                          >
                            <path
                              d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2H13A1.5 1.5 0 0114.5 6.5v5A1.5 1.5 0 0113 13H3A1.5 1.5 0 011.5 11.5v-5A1.5 1.5 0 013 5"
                              stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
                            />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{project.name}</div>
                            <div className="text-xs opacity-60 mt-0.5">
                              {new Date(project.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                            </div>
                          </div>
                          {isActive && (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <path d="M2 7l4 4 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Action area — only when a project is selected */}
              <AnimatePresence>
                {selected && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <div className="px-5 py-4 flex flex-col gap-3">
                      <p className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>
                        Generate map for <span style={{ color: 'var(--foreground)' }}>{selected.name}</span>
                      </p>

                      {/* Mode toggle */}
                      <div
                        className="flex rounded-xl p-1 gap-1"
                        style={{ background: 'var(--secondary)' }}
                      >
                        {(['full', 'custom'] as const).map(m => (
                          <button
                            key={m}
                            onClick={() => setMode(m)}
                            className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                            style={{
                              background: mode === m ? 'var(--background)' : 'transparent',
                              color: mode === m ? 'var(--foreground)' : 'var(--muted-foreground)',
                              boxShadow: mode === m ? 'var(--kg-shadow-sm)' : 'none',
                            }}
                          >
                            {m === 'full' ? 'Full map' : 'Custom prompt'}
                          </button>
                        ))}
                      </div>

                      {/* Mode content */}
                      <AnimatePresence mode="wait">
                        {mode === 'full' ? (
                          <motion.p
                            key="full"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.15 }}
                            className="text-xs"
                            style={{ color: 'var(--muted-foreground)' }}
                          >
                            Extracts every entity and relationship from all documents in this project.
                          </motion.p>
                        ) : (
                          <motion.textarea
                            key="custom"
                            ref={promptRef}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.15 }}
                            value={customPrompt}
                            onChange={e => setCustomPrompt(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                            placeholder="e.g. Focus on financial relationships between companies…"
                            rows={3}
                            className="w-full rounded-xl px-3 py-2.5 text-sm outline-none resize-none"
                            style={{
                              background: 'var(--secondary)',
                              border: '1px solid var(--border)',
                              color: 'var(--foreground)',
                            }}
                          />
                        )}
                      </AnimatePresence>

                      <button
                        onClick={handleGenerate}
                        disabled={isGenerating || (mode === 'custom' && !customPrompt.trim())}
                        className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
                      >
                        {isGenerating
                          ? 'Generating…'
                          : mode === 'full'
                          ? 'Generate Full Map'
                          : 'Generate Map'}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
