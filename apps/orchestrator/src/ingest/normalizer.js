"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTriples = normalizeTriples;
exports.normalizeAndDeduplicate = normalizeAndDeduplicate;
exports.normalizeTriples = normalizeTriples;
// Normalize a label to a canonical slug for comparison
function toSlug(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// Build a canonical ID from a label and type when the agent produced a generic/vague ID
function canonicalId(type, label) {
    return `${type.toLowerCase()}:${toSlug(label)}`;
}
// Remap all triple node IDs to canonical form and deduplicate
function normalizeTriples(triples) {
    // Step1: build a mapping from each seen ID → canonical ID
    // We prefer the first-seen label for a given canonical ID
    const idMap = new Map();
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
    const seen = new Map();
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
function normalizeAndDeduplicate(triples, emittedKeys) {
    const normalized = normalizeTriples(triples);
    const newTriples = [];
    for (const t of normalized) {
        const key = `${t.subject.id}|${t.predicate}|${t.object.id}`;
        if (!emittedKeys.has(key)) {
            emittedKeys.add(key);
            newTriples.push(t);
        }
    }
    return newTriples;
}
// Build a canonical ID from a label and type when the agent produced a generic/vague ID
function canonicalId(type, label) {
    return `${type.toLowerCase()}:${toSlug(label)}`;
}
// Remap all triple node IDs to canonical form and deduplicate
function normalizeTriples(triples) {
    // Step 1: build a mapping from each seen ID → canonical ID
    // We prefer the first-seen label for a given canonical ID
    const idMap = new Map();
    for (const t of triples) {
        for (const node of [t.subject, t.object]) {
            const canonical = canonicalId(node.type, node.label);
            if (!idMap.has(node.id)) {
                idMap.set(node.id, canonical);
            }
        }
    }
    // Step 2: remap IDs and merge properties for the same canonical node
    const remapped = triples.map(t => ({
        ...t,
        subject: { ...t.subject, id: idMap.get(t.subject.id) ?? t.subject.id },
        object: { ...t.object, id: idMap.get(t.object.id) ?? t.object.id },
    }));
    // Step 3: deduplicate by subject-predicate-object key (keep highest confidence)
    const seen = new Map();
    for (const t of remapped) {
        const key = `${t.subject.id}|${t.predicate}|${t.object.id}`;
        const existing = seen.get(key);
        if (!existing || (t.confidence ?? 0) > (existing.confidence ?? 0)) {
            seen.set(key, t);
        }
    }
    return Array.from(seen.values());
}
//# sourceMappingURL=normalizer.js.map