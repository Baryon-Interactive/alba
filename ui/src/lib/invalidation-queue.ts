import type { QueryClient } from '@tanstack/react-query';
import type { QueryKey } from './keys.ts';
const clocks = new WeakMap<QueryClient, Map<string, number>>();

/** Per-client queue: prefixes are expanded before throttling, so overlapping events cannot refetch a query twice. */
export function invalidationQueue(client: QueryClient, visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>) {
  const pending = new Map<string, QueryKey>();
  const last = clocks.get(client) ?? new Map<string, number>();
  clocks.set(client, last);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const schedule = (delay = 150) => { if (!closed && !visibility.hidden && pending.size && !timer) timer = setTimeout(flush, delay); };
  const flush = () => {
    timer = undefined;
    if (visibility.hidden || closed) return;
    const concrete = new Map<string, QueryKey>();
    for (const key of pending.values()) for (const query of client.getQueryCache().findAll({ queryKey: key })) concrete.set(query.queryHash, query.queryKey);
    pending.clear();
    let delay = 2000;
    for (const [hash, key] of concrete) {
      const remaining = (last.get(hash) ?? -Infinity) + 2000 - Date.now();
      if (remaining > 0) { pending.set(hash, key); delay = Math.min(delay, remaining); continue; }
      last.set(hash, Date.now());
      void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
    }
    schedule(delay);
  };
  const visible = () => { if (!visibility.hidden) schedule(); };
  visibility.addEventListener('visibilitychange', visible);
  return {
    add(keys: readonly QueryKey[]) { for (const key of keys) pending.set(JSON.stringify(key), key); schedule(); },
    close() { closed = true; if (timer) clearTimeout(timer); pending.clear(); visibility.removeEventListener('visibilitychange', visible); },
  };
}

const queues = new WeakMap<QueryClient, { queue: ReturnType<typeof invalidationQueue>; users: number }>();
export function sharedInvalidations(client: QueryClient) {
  let entry = queues.get(client);
  if (!entry) { entry = { queue: invalidationQueue(client, document), users: 0 }; queues.set(client, entry); }
  entry.users++;
  return { add: entry.queue.add, close() { if (--entry.users === 0) { entry.queue.close(); queues.delete(client); } } };
}
