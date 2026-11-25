import assert from 'node:assert/strict';
import path from 'node:path';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import { FileStore } from '../src/orders/store.ts';
import { tmpDir } from './tmp.ts';

/** An engine on a temporary directory with a clock that moves one minute per call. */
export function tempOrders(backend?: 'files'): { orders: Orders; dir: string } {
  const dir = tmpDir('alba-test-');
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, tick++)).toISOString();
  return { orders: new Orders(backend === 'files' ? new FileStore(path.join(dir, 'state')) : testStore(path.join(dir, 'state')), clock), dir };
}

export const ready = { status: 'ready' as const, summary: 'done', evidence: [], commits: [] };

/** Reads an event stream into frames. */
export async function openStream(base: string, query: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream?${query}`, { headers, signal: controller.signal });
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> | undefined;     // a read that timed out is kept, so that its message is not lost
  const next = async (ms = 3000): Promise<{ id?: string; event: string; data: any }> => {
    for (;;) {
      const cut = buffer.indexOf('\n\n');
      if (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const frame: { id?: string; event: string; data: any } = { event: 'message', data: undefined };
        let skipped = true;
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) { frame.event = line.slice(7); skipped = false; }
          else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
        }
        if (skipped) continue;       // "retry:" and comments
        return frame;
      }
      pending ??= reader.read();
      let timer: NodeJS.Timeout | undefined;
      let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
      try { chunk = await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no stream message in time')), ms); })]); } finally { clearTimeout(timer); }
      pending = undefined;
      if (chunk.done) throw new Error('the stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, close: () => controller.abort() };
}

