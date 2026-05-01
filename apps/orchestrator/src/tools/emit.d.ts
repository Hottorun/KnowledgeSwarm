import type { Triple } from '../types';
export interface EmitCallbacks {
    emitAgentEvent?: (runId: string, agentName: string, eventType: string, message: string, payload?: Record<string, unknown>) => Promise<void>;
    emitTriples?: (runId: string, agentName: string, triples: Triple[]) => Promise<void>;
}
export declare function setEmitCallbacks(cb: EmitCallbacks): void;
export declare function emitAgentEvent(runId: string, agentName: string, eventType: string, message: string, payload?: Record<string, unknown>): Promise<void>;
export declare function emitTriples(runId: string, agentName: string, triples: Triple[]): Promise<void>;
//# sourceMappingURL=emit.d.ts.map