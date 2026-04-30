import { Response } from 'express';

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

interface EventEnvelope {
  type: string;
  runId?: string;
  timestamp: string;
  payload: unknown;
}

interface Client {
  runId: string;
  res: Response;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const clients = new Map<string, Client>();

let clientIdCounter = 0;

export function addClient(runId: string, res: Response): string {
  const id = `client-${++clientIdCounter}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 15000);

  clients.set(id, { runId, res, heartbeatTimer });

  res.on('close', () => {
    removeClient(id);
  });

  return id;
}

export function removeClient(id: string): void {
  const client = clients.get(id);
  if (client) {
    clearInterval(client.heartbeatTimer);
    clients.delete(id);
  }
}

export function broadcast(event: SseEvent): void {
  const eventRunId = getRunId(event.data);
  const envelope: EventEnvelope = {
    type: event.event,
    runId: eventRunId,
    timestamp: new Date().toISOString(),
    payload: stripRunId(event.data),
  };
  const payload = `event: ${event.event}\nid: ${event.id || Date.now()}\ndata: ${JSON.stringify(envelope)}\n\n`;

  const deadClients: string[] = [];
  for (const [id, client] of clients) {
    if (eventRunId && client.runId !== eventRunId) {
      continue;
    }

    if (client.res.writableEnded) {
      deadClients.push(id);
      continue;
    }
    try {
      client.res.write(payload);
    } catch {
      deadClients.push(id);
    }
  }

  for (const id of deadClients) {
    removeClient(id);
  }
}

export function getClientCount(): number {
  return clients.size;
}

function getRunId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

function stripRunId(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('runId' in data)) {
    return data;
  }

  const { runId: _runId, ...payload } = data as Record<string, unknown>;
  return payload;
}
