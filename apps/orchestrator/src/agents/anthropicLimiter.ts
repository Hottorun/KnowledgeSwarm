import { config } from '../config';

let active = 0;
const queue: Array<() => void> = [];

export async function withAnthropicLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, config.maxAnthropicConcurrency);

  if (active >= limit) {
    await new Promise<void>(resolve => queue.push(resolve));
  }

  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}
