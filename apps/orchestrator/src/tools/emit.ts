import { config } from '../config';
import type { Triple } from '../types';

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
  const res = await fetch(`${config.apiBaseUrl}/runs/${runId}/agent-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, eventType, message, payload }),
  });
  if (!res.ok) {
    console.error(`[emit] agent-events failed: ${res.status}`);
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
  const res = await fetch(`${config.apiBaseUrl}/runs/${runId}/triples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, triples }),
  });
  if (!res.ok) {
    console.error(`[emit] triples failed: ${res.status}`);
  }
}
