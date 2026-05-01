export interface GraphNode {
    id: string;
    label: string;
    type: string;
    properties: Record<string, unknown>;
}
export interface Source {
    url: string;
    title?: string;
    snippet?: string;
}
export interface Triple {
    subject: GraphNode;
    predicate: string;
    object: GraphNode;
    confidence?: number;
    sources?: Source[];
    properties?: Record<string, unknown>;
}
export interface BranchPlan {
    id: string;
    label: string;
    focus: string;
    nodeTypes: string[];
}
export interface DecompositionResult {
    documentType: string;
    branches: BranchPlan[];
}
export interface DocumentChunk {
    index: number;
    text: string;
    startChar: number;
    endChar: number;
}
export interface ExpandRequest {
    runId: string;
    nodeId: string;
    nodeLabel: string;
    nodeType: string;
    context?: string;
}
export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    content?: string;
    score: number;
}
export interface WorkerOutput {
    triples: Triple[];
}
export interface SupervisorOutput {
    approved: Triple[];
    rejected: Array<{
        triple: Triple;
        reason: string;
    }>;
}
//# sourceMappingURL=types.d.ts.map