import type { Triple } from '../types';

// Normalize a label to a canonical slug for comparison
function toSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Build a canonical ID from a label and type when the agent produced a generic/vague ID
function canonicalId(type: string, label: string): string {
  return `${type.toLowerCase()}:${toSlug(label)}`;
}

// Remap all triple node IDs to canonical form and deduplicate
export function normalizeTriples(triples: Triple[]): Triple[] {
  // Step1: build a mapping from each seen ID → canonical ID
  // We prefer the first-seen label for a given canonical ID
  const idMap = new Map<string, string>();

  for (const t of triples) {
    for (const node of [t.subject, t.object]) {
      const canonical = canonicalId(node.type, node.label);
      if (!idMap.has(node.id)) {
        idMap.set(node.id, canonical);
      }
    }
  }

  // Step2: remap IDs and merge properties for the same canonical node
  const remapped = triples.map(t => ({
    ...t,
    subject: { ...t.subject, id: idMap.get(t.subject.id) ?? t.subject.id },
    object: { ...t.object, id: idMap.get(t.object.id) ?? t.object.id },
  }));

  // Step3: deduplicate by subject-predicate-object key (keep highest confidence)
  const seen = new Map<string, Triple>();
  for (const t of remapped) {
    const key = `${t.subject.id}|${t.predicate}|${t.object.id}`;
    const existing = seen.get(key);
    if (!existing || (t.confidence ?? 0) > (existing.confidence ?? 0)) {
      seen.set(key, t);
    }
  }

  return Array.from(seen.values());
}

// Normalize triples and deduplicate against an existing set of keys
// Returns only the new triples that weren't already emitted
export function normalizeAndDeduplicate(triples: Triple[], emittedKeys: Set<string>): Triple[] {
  const normalized = normalizeTriples(triples);
  const newTriples: Triple[] = [];

  for (const t of normalized) {
    const key = `${t.subject.id}|${t.predicate}|${t.object.id}`;
    if (!emittedKeys.has(key)) {
      emittedKeys.add(key);
      newTriples.push(t);
    }
  }

  return newTriples;
}

export function keepLargestConnectedComponent(triples: Triple[]): { triples: Triple[]; removed: number } {
  if (triples.length === 0) return { triples, removed: 0 };

  const adjacency = new Map<string, Set<string>>();
  const nodeIds = new Set<string>();

  for (const triple of triples) {
    nodeIds.add(triple.subject.id);
    nodeIds.add(triple.object.id);
    if (!adjacency.has(triple.subject.id)) adjacency.set(triple.subject.id, new Set());
    if (!adjacency.has(triple.object.id)) adjacency.set(triple.object.id, new Set());
    adjacency.get(triple.subject.id)?.add(triple.object.id);
    adjacency.get(triple.object.id)?.add(triple.subject.id);
  }

  const components: string[][] = [];
  const seen = new Set<string>();

  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    const queue = [id];
    const component: string[] = [];
    seen.add(id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const keepIds = new Set(components[0] ?? []);
  const connectedTriples = triples.filter(triple => keepIds.has(triple.subject.id) && keepIds.has(triple.object.id));

  return { triples: connectedTriples, removed: triples.length - connectedTriples.length };
}
