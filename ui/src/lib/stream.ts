import type { QueryClient } from '@tanstack/react-query';
import type { TranscriptEntry } from '@api';
import { toast } from 'sonner';
import { everything, invalidationsFor, STREAM_EVENT_NAMES } from './events.ts';
import { sharedInvalidations } from './invalidation-queue.ts';

export type StreamState = 'connecting' | 'live' | 'reconnecting';

export interface StreamHandle { close(): void }

/**
 * One EventSource on `/api/stream`. The browser reconnects by itself and sends Last-Event-ID; when it was away, `onopen` after an
 * error reads every list again once. Invalidations share a two-second per-query throttle and wait while the tab is hidden.
 */
export function openStream(opts: {
  project: string;
  logs?: string[];
  transcripts?: string[];
  client?: QueryClient;
  backgroundOrders?: () => boolean;
  onState?: (s: StreamState) => void;
  onRunLog?: (e: { key: string; lines: string[]; offset: number }) => void;
  onRunTranscript?: (e: { project: string; key: string; entries: TranscriptEntry[] }) => void;
}): StreamHandle {
  const params = new URLSearchParams({ project: opts.project });
  if (opts.logs?.length) params.set('logs', opts.logs.join(','));
  if (opts.transcripts?.length) params.set('transcripts', opts.transcripts.join(','));
  const es = new EventSource(`/api/stream?${params}`);
  const invalidations = opts.client ? sharedInvalidations(opts.client) : undefined;
  let hadError = false;

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const queue = (list: readonly (readonly unknown[])[]) => {
    invalidations?.add(list);
    if (!refreshTimer && document.hidden && opts.backgroundOrders?.() && list.some(key => key[0] === 'orders')) {
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void opts.client?.refetchQueries({ queryKey: ['orders', opts.project], exact: true, type: 'active' }, { cancelRefetch: false });
      }, 500);
    }
  };

  es.onopen = () => {
    opts.onState?.('live');
    if (hadError) { hadError = false; queue(everything); }
  };
  es.onerror = () => { hadError = true; opts.onState?.(es.readyState === EventSource.CLOSED ? 'connecting' : 'reconnecting'); };
  for (const name of STREAM_EVENT_NAMES) {
    es.addEventListener(name, (ev) => {
      let data: unknown;
      try { data = JSON.parse((ev as MessageEvent<string>).data); } catch { return; }
      if (name === 'run.log') { opts.onRunLog?.(data as { key: string; lines: string[]; offset: number }); return; }
      if (name === 'run.transcript') { opts.onRunTranscript?.(data as { project: string; key: string; entries: TranscriptEntry[] }); return; }
      if (name === 'serve.notice') {
        const n = data as { kind: string; text: string };
        if (n.kind === 'config-invalid' || n.kind === 'table-import-failed' || n.kind === 'silent-end') toast.warning(n.text);
      }
      queue(invalidationsFor(name, data, opts.project));
    });
  }
  return { close() { es.close(); clearTimeout(refreshTimer); invalidations?.close(); } };
}
