import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AIReasoningStep } from './types';
import type { Node, Edge } from '@xyflow/react';
import type { GraphNodeData } from './GraphNode';

function TocTree({ sections, onNodeFocus }: { sections: any[]; onNodeFocus?: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      {sections.map((section) => (
        <div key={section.id}>
          <div className="flex items-center">
            <button
              onClick={() => toggle(section.id)}
              className="w-5 h-5 flex items-center justify-center shrink-0 rounded transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="none"
                style={{ transform: expanded.has(section.id) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
              >
                <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={() => onNodeFocus?.(section.id)}
              className="flex-1 text-left rounded-lg px-2 py-1.5 text-sm font-semibold transition-colors hover:bg-accent"
              style={{ color: 'var(--foreground)' }}
            >
              {section.label}
            </button>
          </div>
          <AnimatePresence>
            {expanded.has(section.id) && section.children?.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                {section.children.map((child: any) => (
                  <div key={child.id} className="pl-4">
                    <div className="flex items-center">
                      {child.subs?.length > 0 && (
                        <button
                          onClick={() => toggle(child.id)}
                          className="w-5 h-5 flex items-center justify-center shrink-0 rounded transition-colors hover:bg-accent"
                          style={{ color: 'var(--muted-foreground)' }}
                        >
                          <svg
                            width="8" height="8" viewBox="0 0 10 10" fill="none"
                            style={{ transform: expanded.has(child.id) ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                          >
                            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                      {!child.subs?.length && <span className="w-5" />}
                      <button
                        onClick={() => onNodeFocus?.(child.id)}
                        className="flex-1 text-left rounded-lg px-2 py-1 text-xs font-medium transition-colors hover:bg-accent"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        {child.label}
                      </button>
                    </div>
                    <AnimatePresence>
                      {expanded.has(child.id) && child.subs?.length > 0 && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden pl-5"
                        >
                          {child.subs.map((sub: any) => (
                            <button
                              key={sub.id}
                              onClick={() => onNodeFocus?.(sub.id)}
                              className="w-full text-left rounded-lg px-2 py-1 text-xs transition-colors hover:bg-accent"
                              style={{ color: 'var(--muted-foreground)', opacity: 0.75 }}
                            >
                              {sub.label}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

interface SidePanelProps {
  side: 'left' | 'right';
  isOpen: boolean;
  onClose: () => void;
  nodes?: Node[];
  edges?: Edge[];
  onNodeFocus?: (nodeId: string) => void;
  reasoningSteps?: AIReasoningStep[];
}

export function SidePanel({ side, isOpen, onClose, nodes = [], edges = [], onNodeFocus, reasoningSteps = [] }: SidePanelProps) {
  const isLeft = side === 'left';

  // Build table of contents: group nodes by type (root > topics > subtopics)
  const tocSections = (() => {
    if (!isLeft || nodes.length === 0) return [];
    const rootNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'root');
    const topicNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'topic');
    const subtopicNodes = nodes.filter(n => (n.data as GraphNodeData).nodeType === 'subtopic');

    // Build a map of parent -> children from edges
    const childrenMap = new Map<string, string[]>();
    edges.forEach(e => {
      const list = childrenMap.get(e.source) || [];
      list.push(e.target);
      childrenMap.set(e.source, list);
    });

    const sections: { id: string; label: string; type: string; children: { id: string; label: string }[] }[] = [];

    // Add root nodes
    rootNodes.forEach(root => {
      const rootChildren = (childrenMap.get(root.id) || [])
        .map(cid => topicNodes.find(n => n.id === cid))
        .filter(Boolean) as Node[];

      sections.push({
        id: root.id,
        label: (root.data as GraphNodeData).label,
        type: 'root',
        children: rootChildren.map(topic => ({
          id: topic.id,
          label: (topic.data as GraphNodeData).label,
        })),
      });
    });

    // Add topics that aren't already children of root
    const rootChildIds = new Set(sections.flatMap(s => s.children.map(c => c.id)));
    topicNodes.filter(t => !rootChildIds.has(t.id)).forEach(topic => {
      const topicChildren = (childrenMap.get(topic.id) || [])
        .map(cid => subtopicNodes.find(n => n.id === cid))
        .filter(Boolean) as Node[];
      sections.push({
        id: topic.id,
        label: (topic.data as GraphNodeData).label,
        type: 'topic',
        children: topicChildren.map(sub => ({
          id: sub.id,
          label: (sub.data as GraphNodeData).label,
        })),
      });
    });

    // For topics that are children of root, also add their subtopics inline
    // Rebuild sections to nest subtopics under topics
    const enriched = sections.map(section => {
      if (section.type === 'root') {
        return {
          ...section,
          children: section.children.map(topic => {
            const subs = (childrenMap.get(topic.id) || [])
              .map(cid => subtopicNodes.find(n => n.id === cid))
              .filter(Boolean) as Node[];
            return {
              ...topic,
              subs: subs.map(s => ({ id: s.id, label: (s.data as GraphNodeData).label })),
            };
          }),
        };
      }
      return section;
    });

    return enriched;
  })();

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: isLeft ? -380 : 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: isLeft ? -380 : 380, opacity: 0 }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className={`fixed top-0 ${isLeft ? 'left-0' : 'right-0'} h-full w-[360px] z-40`}
          style={{
            background: 'var(--kg-panel-bg)',
            backdropFilter: 'blur(24px)',
            borderRight: isLeft ? '1px solid var(--border)' : 'none',
            borderLeft: isLeft ? 'none' : '1px solid var(--border)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
            <h3
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--foreground)' }}
            >
              {isLeft ? 'Table of Contents' : 'AI Reasoning'}
            </h3>
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
            >
              ✕
            </button>
          </div>

          {/* Content */}
          <div className="p-5 overflow-y-auto" style={{ height: 'calc(100% - 57px)' }}>
            {isLeft ? (
              tocSections.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Build a mind map to see its table of contents here.
                </p>
              ) : (
                <TocTree sections={tocSections} onNodeFocus={onNodeFocus} />
              )
            ) : (
              reasoningSteps.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  AI reasoning will appear here as the graph is built.
                </p>
              ) : (
                <div className="space-y-3">
                  {reasoningSteps.map((step, idx) => (
                    <motion.div
                      key={step.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="rounded-xl px-4 py-3"
                      style={{
                        background: 'var(--secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: step.type === 'analysis' ? 'var(--kg-node-hover)' :
                                        step.type === 'connection' ? 'oklch(0.85 0.08 160 / 20%)' :
                                        'oklch(0.85 0.08 50 / 20%)',
                            color: step.type === 'analysis' ? 'var(--primary)' :
                                   step.type === 'connection' ? 'oklch(0.45 0.12 160)' :
                                   'oklch(0.45 0.12 50)',
                          }}
                        >
                          {step.type}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--foreground)' }}>
                        {step.text}
                      </p>
                    </motion.div>
                  ))}
                </div>
              )
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}