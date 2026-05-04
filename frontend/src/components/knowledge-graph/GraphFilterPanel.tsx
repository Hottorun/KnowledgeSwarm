import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';

export interface GraphFilters {
  categories: Set<string>;
  documents: Set<string>;
  entityTypes: Set<string>;
  sourceKinds: Set<string>;
  minImportance: number;
}

export function makeEmptyFilters(): GraphFilters {
  return { categories: new Set(), documents: new Set(), entityTypes: new Set(), sourceKinds: new Set(), minImportance: 0 };
}

export function hasActiveFilters(filters: GraphFilters): boolean {
  return filters.categories.size > 0 ||
    filters.documents.size > 0 ||
    filters.entityTypes.size > 0 ||
    filters.sourceKinds.size > 0 ||
    filters.minImportance > 0;
}

// Scaffold/main-entity nodes are structural — never filtered out. Filters
// only hide concrete entity/fact nodes that explicitly carry the filter field.
function isStructuralNode(node: GraphNode): boolean {
  const role = (node.data as GraphNodeData).presentationRole;
  return role === 'main_entity' || role === 'category' || role === 'business_area' || role === 'document';
}

function sourceKindFromUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return 'unknown';
  if (/^https?:\/\//i.test(url)) return 'web';
  if (/^local:\/\//i.test(url)) return 'document';
  return 'local';
}

function edgeSourceKinds(edge: GraphEdge): Set<string> {
  const data = edge.data as { sources?: Array<{ url?: string }> } | undefined;
  const kinds = new Set<string>();
  for (const source of data?.sources ?? []) kinds.add(sourceKindFromUrl(source.url));
  if (kinds.size === 0) kinds.add('unknown');
  return kinds;
}

function collectNodeSourceKinds(edges: GraphEdge[]): Map<string, Set<string>> {
  const byNode = new Map<string, Set<string>>();
  for (const edge of edges) {
    const kinds = edgeSourceKinds(edge);
    for (const nodeId of [edge.source, edge.target]) {
      const current = byNode.get(nodeId) ?? new Set<string>();
      for (const kind of kinds) current.add(kind);
      byNode.set(nodeId, current);
    }
  }
  return byNode;
}

function nodePassesFilters(node: GraphNode, filters: GraphFilters, nodeSourceKinds: Map<string, Set<string>>): boolean {
  if (isStructuralNode(node)) return true;
  const data = node.data as GraphNodeData;

  if (filters.minImportance > 0) {
    const imp = data.importance;
    if (typeof imp === 'number' && imp < filters.minImportance) return false;
  }

  if (filters.categories.size > 0) {
    const c = data.category;
    if (typeof c === 'string' && c && !filters.categories.has(c)) return false;
  }

  if (filters.documents.size > 0) {
    const d = data.documentName;
    if (typeof d === 'string' && d && !filters.documents.has(d)) return false;
  }

  if (filters.entityTypes.size > 0) {
    const entityType = String(data.description ?? data.nodeType ?? 'Entity');
    if (!filters.entityTypes.has(entityType)) return false;
  }

  if (filters.sourceKinds.size > 0) {
    const kinds = nodeSourceKinds.get(node.id) ?? new Set([String(data.sourceKind ?? data.sourceType ?? (data.documentName ? 'document' : 'unknown'))]);
    if (![...kinds].some(kind => filters.sourceKinds.has(kind))) return false;
  }

  return true;
}

export function applyFilters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  filters: GraphFilters,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!hasActiveFilters(filters)) return { nodes, edges };
  const nodeSourceKinds = collectNodeSourceKinds(edges);
  const filteredNodes = nodes.filter(n => nodePassesFilters(n, filters, nodeSourceKinds));
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  return { nodes: filteredNodes, edges: filteredEdges };
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  nodes: GraphNode[];
  edges: GraphEdge[];
  filters: GraphFilters;
  onFiltersChange: (filters: GraphFilters) => void;
  visibleCount: number;
  totalCount: number;
}

export function GraphFilterPanel({ isOpen, onClose, nodes, edges, filters, onFiltersChange, visibleCount, totalCount }: Props) {
  const { availableCategories, availableDocuments, availableEntityTypes, availableSourceKinds, importanceRange } = useMemo(() => {
    const cats = new Map<string, number>();
    const docs = new Map<string, number>();
    const entityTypes = new Map<string, number>();
    const sourceKinds = new Map<string, number>();
    let minImp = 1;
    let maxImp = 0;
    let hasImp = false;
    const nodeSourceKinds = collectNodeSourceKinds(edges);
    for (const n of nodes) {
      if (isStructuralNode(n)) continue;
      const d = n.data as GraphNodeData;
      if (typeof d.category === 'string' && d.category) cats.set(d.category, (cats.get(d.category) ?? 0) + 1);
      if (typeof d.documentName === 'string' && d.documentName) docs.set(d.documentName, (docs.get(d.documentName) ?? 0) + 1);
      const entityType = String(d.description ?? d.nodeType ?? 'Entity');
      entityTypes.set(entityType, (entityTypes.get(entityType) ?? 0) + 1);
      const kinds = nodeSourceKinds.get(n.id) ?? new Set([String(d.sourceKind ?? d.sourceType ?? (d.documentName ? 'document' : 'unknown'))]);
      for (const sourceKind of kinds) sourceKinds.set(sourceKind, (sourceKinds.get(sourceKind) ?? 0) + 1);
      if (typeof d.importance === 'number') {
        hasImp = true;
        minImp = Math.min(minImp, d.importance);
        maxImp = Math.max(maxImp, d.importance);
      }
    }
    return {
      availableCategories: [...cats.entries()].sort((a, b) => b[1] - a[1]),
      availableDocuments: [...docs.entries()].sort((a, b) => b[1] - a[1]),
      availableEntityTypes: [...entityTypes.entries()].sort((a, b) => b[1] - a[1]),
      availableSourceKinds: [...sourceKinds.entries()].sort((a, b) => b[1] - a[1]),
      importanceRange: hasImp ? { min: minImp, max: maxImp } : null,
    };
  }, [edges, nodes]);

  const toggleCategory = (c: string) => {
    const next = new Set(filters.categories);
    if (next.has(c)) next.delete(c); else next.add(c);
    onFiltersChange({ ...filters, categories: next });
  };
  const toggleDocument = (d: string) => {
    const next = new Set(filters.documents);
    if (next.has(d)) next.delete(d); else next.add(d);
    onFiltersChange({ ...filters, documents: next });
  };
  const toggleEntityType = (t: string) => {
    const next = new Set(filters.entityTypes);
    if (next.has(t)) next.delete(t); else next.add(t);
    onFiltersChange({ ...filters, entityTypes: next });
  };
  const toggleSourceKind = (s: string) => {
    const next = new Set(filters.sourceKinds);
    if (next.has(s)) next.delete(s); else next.add(s);
    onFiltersChange({ ...filters, sourceKinds: next });
  };
  const setImportance = (v: number) => onFiltersChange({ ...filters, minImportance: v });
  const clearAll = () => onFiltersChange(makeEmptyFilters());

  const hidden = totalCount - visibleCount;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="fixed top-14 right-5 z-50 w-80 rounded-2xl overflow-hidden"
            style={{
              background: 'var(--kg-node-bg)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--kg-shadow-lg, 0 20px 50px -10px rgba(0,0,0,0.25))',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Filters</span>
                <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                  {visibleCount} / {totalCount} visible{hidden > 0 ? ` · ${hidden} hidden` : ''}
                </span>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Min importance</span>
                  <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                    {filters.minImportance > 0 ? `≥ ${filters.minImportance.toFixed(2)}` : 'all'}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={filters.minImportance}
                  onChange={(e) => setImportance(parseFloat(e.target.value))}
                  className="w-full accent-current"
                  style={{ color: 'var(--primary)' }}
                />
                {importanceRange && (
                  <div className="flex justify-between text-[9px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    <span>graph min: {importanceRange.min.toFixed(2)}</span>
                    <span>max: {importanceRange.max.toFixed(2)}</span>
                  </div>
                )}
              </div>

              {availableCategories.length > 0 && (
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Categories</span>
                    {filters.categories.size > 0 && (
                      <button
                        onClick={() => onFiltersChange({ ...filters, categories: new Set() })}
                        className="text-[10px] hover:underline"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {availableCategories.map(([c, count]) => (
                      <label key={c} className="flex items-center gap-2 cursor-pointer text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={filters.categories.has(c)}
                          onChange={() => toggleCategory(c)}
                        />
                        <span className="flex-1 truncate" style={{ color: 'var(--foreground)' }}>{c}</span>
                        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {availableEntityTypes.length > 0 && (
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Entity types</span>
                    {filters.entityTypes.size > 0 && (
                      <button
                        onClick={() => onFiltersChange({ ...filters, entityTypes: new Set() })}
                        className="text-[10px] hover:underline"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {availableEntityTypes.slice(0, 24).map(([entityType, count]) => (
                      <label key={entityType} className="flex items-center gap-2 cursor-pointer text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={filters.entityTypes.has(entityType)}
                          onChange={() => toggleEntityType(entityType)}
                        />
                        <span className="flex-1 truncate" style={{ color: 'var(--foreground)' }} title={entityType}>{entityType}</span>
                        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {availableSourceKinds.length > 0 && (
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Sources</span>
                    {filters.sourceKinds.size > 0 && (
                      <button
                        onClick={() => onFiltersChange({ ...filters, sourceKinds: new Set() })}
                        className="text-[10px] hover:underline"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {availableSourceKinds.map(([sourceKind, count]) => (
                      <label key={sourceKind} className="flex items-center gap-2 cursor-pointer text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={filters.sourceKinds.has(sourceKind)}
                          onChange={() => toggleSourceKind(sourceKind)}
                        />
                        <span className="flex-1 truncate capitalize" style={{ color: 'var(--foreground)' }}>{sourceKind}</span>
                        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {availableDocuments.length > 0 && (
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Documents</span>
                    {filters.documents.size > 0 && (
                      <button
                        onClick={() => onFiltersChange({ ...filters, documents: new Set() })}
                        className="text-[10px] hover:underline"
                        style={{ color: 'var(--muted-foreground)' }}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {availableDocuments.map(([d, count]) => (
                      <label key={d} className="flex items-center gap-2 cursor-pointer text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={filters.documents.has(d)}
                          onChange={() => toggleDocument(d)}
                        />
                        <span className="flex-1 truncate" style={{ color: 'var(--foreground)' }} title={d}>{d}</span>
                        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {availableCategories.length === 0 && availableDocuments.length === 0 && availableEntityTypes.length === 0 && availableSourceKinds.length === 0 && !importanceRange && (
                <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  No filterable metadata yet — keep extracting to populate categories, documents, and importance.
                </div>
              )}
            </div>

            {hasActiveFilters(filters) && (
              <div className="px-4 py-2 border-t flex justify-end" style={{ borderColor: 'var(--border)' }}>
                <button
                  onClick={clearAll}
                  className="text-xs hover:underline"
                  style={{ color: 'var(--primary)' }}
                >
                  Clear all filters
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
