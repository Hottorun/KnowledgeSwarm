import type { BranchPlan } from '../types';
export type SpecialistKind = 'finance' | 'legal' | 'technical' | 'market' | 'people' | 'risk' | 'general';
export interface SpecialistProfile {
    kind: SpecialistKind;
    agentName: string;
    nodeTypes: string[];
    extractionHint: string;
    preferredPredicates: string[];
}
export declare function specialistForBranch(branch: BranchPlan): SpecialistProfile;
export declare function specialistDisplayName(specialist: SpecialistProfile, branch: BranchPlan): string;
//# sourceMappingURL=specialists.d.ts.map