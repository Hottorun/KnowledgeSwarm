import { EmitCallbacks } from './tools/emit';
export { expandNode } from './agents/expander';
export interface OrchestratorCallbacks extends EmitCallbacks {
}
export declare function orchestrate(runId: string, documentText: string, documentName?: string, callbacks?: OrchestratorCallbacks): Promise<void>;
//# sourceMappingURL=index.d.ts.map