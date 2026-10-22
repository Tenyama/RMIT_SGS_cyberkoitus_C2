import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StreamEvent } from '../../shared/types.ts';

type Listener = (ev: StreamEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(ev: StreamEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // one bad subscriber must not break the others
    }
  }
}

/** GET /api/stream — default `message` events (no `event:` name) so EventSource.onmessage works. */
export function streamHandler(c: Context, heartbeatMs: number = 15_000) {
  return streamSSE(c, async (stream) => {
    const send = (ev: StreamEvent) => {
      stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
    };
    const off = subscribe(send);
    const hb = setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), heartbeatMs);
    send({ type: 'heartbeat', ts: Date.now() });
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(hb);
    off();
  });
}
