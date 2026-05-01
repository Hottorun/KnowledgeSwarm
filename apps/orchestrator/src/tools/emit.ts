import { config } from '../config';
import type { Triple } from '../types';

export interface EmitCallbacks {
  emitAgentEvent?: (runId: string, agentName: string, eventType: string, message: string, payload?: Record<string, unknown>) => Promise<void>;
  emitTriples?: (runId: string, agentName: string, triples: Triple[]) => Promise<void>;
}

let _callbacks: EmitCallbacks = {};

export function setEmitCallbacks(cb: EmitCallbacks): void {
  _callbacks = cb;
}

export async function emitAgentEvent(
  runId: string,
  agentName: string,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  if (config.stubMode) {
    console.log(`  [${agentName}] ${eventType}: ${message}`);
    return;
  }
  if (_callbacks.emitAgentEvent) {
    return _callbacks.emitAgentEvent(runId, agentName, eventType, message, payload);
  }
  const res = await fetch(`${config.apiBaseUrl}/runs/${runId}/agent-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, eventType, message, payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[emit] agent-events failed: ${res.status} ${body}`);
  }
}

export async function emitTriples(
  runId: string,
  agentName: string,
  triples: Triple[]
): Promise<void> {
  if (triples.length === 0) return;
  if (config.stubMode) {
    console.log(`  [${agentName}] pushing ${triples.length} triple(s):`);
    triples.forEach(t =>
      console.log(`    ${t.subject.label} -[${t.predicate}]-> ${t.object.label} (conf: ${t.confidence ?? '?'})`)
    );
    return;
  }
  if (_callbacks.emitTriples) {
    return _callbacks.emitTriples(runId, agentName, triples);
  }
  const res = await fetch(`${config.apiBaseUrl}/runs/${runId}/triples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, triples }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[emit] triples failed: ${res.status} ${body}`);
  }
}
