import type { BranchPlan, DocumentChunk, WorkerOutput } from '../types';
import type { SpecialistProfile } from './specialists';
export declare function runWorker(chunk: DocumentChunk, focusNodeTypes: string[], specialist: SpecialistProfile, branch: BranchPlan, documentName: string): Promise<WorkerOutput>;
//# sourceMappingURL=worker.d.ts.map