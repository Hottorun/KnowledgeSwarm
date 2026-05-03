import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';

interface TocDropdownProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeFocus: (nodeId: string) => void;
}

export function TocDropdown({ nodes, edges, onNodeFocus }: TocDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Build TOC tree
  const childrenMap = new Map<string, string[]>();
  edges.forEach(e => {
    const list = childrenMap.get(e.source) || [];
    list.push(e.target);
    childrenMap.set(e.source, list);
  });

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const rootNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'root');
  const topicNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'topic');
  const subtopicNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'subtopic');

  const sections = rootNodes.map(root => ({
    id: root.id,
    label: (root.data as GraphNodeData).label,
    topics: (childrenMap.get(root.id) || [])
      .map(id => nodeMap.get(id))
      .filter((n): n is GraphNode => !!n && (n.data as GraphNodeData).nodeType === 'topic')
      .map(topic => ({
        id: topic.id,
        label: (topic.data as GraphNodeData).label,
        subs: (childrenMap.get(topic.id) || [])
          .map(id => nodeMap.get(id))
          .filter((n): n is GraphNode => !!n && (n.data as GraphNodeData).nodeType === 'subtopic')
          .map(sub => ({ id: sub.id, label: (sub.data as GraphNodeData).label })),
      })),
  }));

  const handleClick = (id: string) => {
    onNodeFocus(id);
    setIsOpen(false);
  };

  if (nodes.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 hover:bg-accent"
        style={{
          background: isOpen ? 'var(--primary)' : 'transparent',
          color: isOpen ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
        }}
      >
        <span className="text-sm">📑</span>
        Contents
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        >
          <path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute left-0 top-10 w-64 max-h-[70vh] overflow-y-auto rounded-xl py-2"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--kg-shadow-lg)',
              backdropFilter: 'blur(24px)',
            }}
          >
            {sections.map(section => (
              <div key={section.id}>
                <button
                  onClick={() => handleClick(section.id)}
                  className="w-full text-left px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent flex items-center gap-2"
                  style={{ color: 'var(--foreground)' }}
                >
                  <span className="text-xs opacity-50">●</span>
                  {section.label}
                </button>
                {section.topics.map(topic => (
                  <div key={topic.id}>
                    <button
                      onClick={() => handleClick(topic.id)}
                      className="w-full text-left px-4 py-1.5 pl-8 text-xs font-medium transition-colors hover:bg-accent"
                      style={{ color: 'var(--muted-foreground)' }}
                    >
                      {topic.label}
                    </button>
                    {topic.subs.map(sub => (
                      <button
                        key={sub.id}
                        onClick={() => handleClick(sub.id)}
                        className="w-full text-left px-4 py-1 pl-12 text-xs transition-colors hover:bg-accent"
                        style={{ color: 'var(--muted-foreground)', opacity: 0.75 }}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
