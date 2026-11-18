import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, ArrowDownToLine, ChevronUp, Loader2, Pause, Play, Search, X } from 'lucide-react';
import type { RunUsage, TranscriptEntry } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, ErrorBox } from '@/components/common';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { openStream } from '@/lib/stream';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { TranscriptEntryCard } from './TranscriptEntryCard';
import {
  TRANSCRIPT_CATEGORIES,
  countFailedCommands,
  countTranscriptCategories,
  earlierPageQuery,
  filterTranscriptEntries,
  mergeTranscriptEntries,
  nextFailedCommandSeq,
  shouldFollowTranscript,
  type TranscriptFilterCategory,
} from './TranscriptLogic';

const PAGE_SIZE = 200;

function estimateEntrySize(entry: TranscriptEntry | undefined): number {
  if (!entry) return 56;
  switch (entry.kind) {
    case 'reasoning':
      return 42;
    case 'command':
      return entry.state === 'failed' && entry.output ? 180 : 48;
    case 'tool':
    case 'search':
      return 48;
    case 'edit':
      return 160;
    case 'message':
    case 'result':
      return 110;
    case 'plan':
    case 'error':
    case 'log':
      return 96;
  }
}

function categoryLabel(cat: TranscriptFilterCategory): string {
  switch (cat) {
    case 'all':
      return t('All');
    case 'messages':
      return t('Messages');
    case 'commands':
      return t('Commands');
    case 'edits':
      return t('Edits');
    case 'errors':
      return t('Errors');
  }
}

export function TranscriptView({
  project,
  runKey,
  live,
  runUsage,
  onLoadedEntries,
}: {
  project: string;
  runKey: string;
  live: boolean;
  runUsage?: RunUsage;
  onLoadedEntries?: (entries: readonly TranscriptEntry[]) => void;
}) {
  const first = useQuery({
    queryKey: keys.runTranscript(project, runKey),
    queryFn: () => api.runTranscript(project, runKey, { limit: PAGE_SIZE }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);
  const [windowStartSeq, setWindowStartSeq] = useState<number | undefined>(undefined);
  const [total, setTotal] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const [category, setCategory] = useState<TranscriptFilterCategory>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [connected, setConnected] = useState(false);
  const [focusedSeq, setFocusedSeq] = useState<number | undefined>(undefined);
  const [pendingScrollSeq, setPendingScrollSeq] = useState<number | undefined>(undefined);

  const parentRef = useRef<HTMLDivElement>(null);
  const programmaticRef = useRef(false);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const entriesRef = useRef<TranscriptEntry[]>([]);
  const totalRef = useRef(0);

  entriesRef.current = entries;
  totalRef.current = total;

  useEffect(() => {
    setEntries([]);
    setNextCursor(undefined);
    setWindowStartSeq(undefined);
    setTotal(0);
    setDropped(0);
    setFocusedSeq(undefined);
    setFollow(true);
  }, [project, runKey]);

  useEffect(() => {
    if (!first.data) return;
    setEntries(first.data.entries);
    setNextCursor(first.data.next);
    setWindowStartSeq(first.data.entries[0]?.seq);
    setTotal(first.data.total);
    setDropped(first.data.dropped);
    onLoadedEntries?.(first.data.entries);
  }, [first.data, onLoadedEntries]);

  useEffect(() => {
    if (!live || !first.data) return;
    let sawDisconnect = false;
    const h = openStream({
      project,
      transcripts: [`${runKey}@${first.data.total}`],
      onState: s => {
        setConnected(s === 'live');
        if (s === 'reconnecting') sawDisconnect = true;
        else if (s === 'live' && sawDisconnect) {
          sawDisconnect = false;
          const earliestRunning = entriesRef.current.find(e => e.state === 'running')?.seq;
          const after = earliestRunning !== undefined ? Math.min(earliestRunning, totalRef.current) : totalRef.current;
          void api.runTranscript(project, runKey, { after, limit: 1000 }).then(res => {
            setEntries(prev => mergeTranscriptEntries(prev, res.entries));
            setTotal(res.total);
            setDropped(res.dropped);
          }).catch(() => undefined);
        }
      },
      onRunTranscript: ev => {
        if (ev.key !== runKey || !ev.entries.length) return;
        setEntries(prev => mergeTranscriptEntries(prev, ev.entries));
        const maxSeq = ev.entries.reduce((m, e) => Math.max(m, e.seq), -1);
        if (maxSeq >= 0) setTotal(prev => Math.max(prev, maxSeq + 1));
      },
    });
    return () => {
      h.close();
      setConnected(false);
    };
  }, [live, project, runKey, first.data]);

  const counts = useMemo(() => countTranscriptCategories(entries), [entries]);
  const failedCommands = useMemo(() => countFailedCommands(entries), [entries]);
  const filtered = useMemo(() => filterTranscriptEntries(entries, category, query), [entries, category, query]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index => estimateEntrySize(filtered[index]),
    measureElement: el => el?.getBoundingClientRect().height ?? 56,
    getItemKey: index => filtered[index]?.seq ?? index,
    overscan: 12,
  });

  const scrollToEnd = useCallback(() => {
    const el = parentRef.current;
    if (!el || !filtered.length) return;
    programmaticRef.current = true;
    virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      if (parentRef.current) parentRef.current.scrollTop = parentRef.current.scrollHeight;
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    });
  }, [filtered.length, virtualizer]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const el = parentRef.current;
    if (anchor && el) {
      prependAnchorRef.current = null;
      programmaticRef.current = true;
      const delta = el.scrollHeight - anchor.scrollHeight;
      if (delta > 0) el.scrollTop = anchor.scrollTop + delta;
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
      return;
    }
    if (follow && filtered.length > 0) {
      scrollToEnd();
    }
  }, [entries, filtered.length, follow, scrollToEnd]);

  useEffect(() => {
    if (pendingScrollSeq === undefined) return;
    const idx = filtered.findIndex(e => e.seq === pendingScrollSeq);
    if (idx < 0) return;
    setPendingScrollSeq(undefined);
    programmaticRef.current = true;
    virtualizer.scrollToIndex(idx, { align: 'center' });
    requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
  }, [pendingScrollSeq, filtered, virtualizer]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const next = shouldFollowTranscript({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      currentFollow: follow,
      programmatic: programmaticRef.current,
    });
    if (next !== follow) setFollow(next);
  };

  const loadEarlier = async () => {
    const req = earlierPageQuery(windowStartSeq, nextCursor, PAGE_SIZE);
    if (!req || loadingEarlier) return;
    setLoadingEarlier(true);
    setFollow(false);
    try {
      const res = await api.runTranscript(project, runKey, req);
      const el = parentRef.current;
      if (el) prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      setEntries(prev => mergeTranscriptEntries(res.entries, prev));
      setWindowStartSeq(req.after);
      setNextCursor(res.next);
      setTotal(res.total);
      setDropped(res.dropped);
    } finally {
      setLoadingEarlier(false);
    }
  };

  const jumpToNextFailed = () => {
    const seq = nextFailedCommandSeq(entries, focusedSeq);
    if (seq === undefined) return;
    setFollow(false);
    setFocusedSeq(seq);
    if (!filtered.some(e => e.seq === seq)) {
      if (category !== 'all' && category !== 'commands' && category !== 'errors') setCategory('all');
      if (query.trim()) setQuery('');
    }
    setPendingScrollSeq(seq);
  };

  if (first.isError) return <ErrorBox error={first.error} />;

  return (
    <div className="relative overflow-hidden rounded-xl border bg-card shadow-xs">
      {/* Toolbar: filter chips, failed-command jump, text search, live follow state */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('Transcript filters')}>
          {TRANSCRIPT_CATEGORIES.map(cat => {
            const active = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-primary/40 bg-primary/14 text-foreground'
                    : 'border-transparent bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <span>{categoryLabel(cat)}</span>
                <span className="font-mono text-[11px] opacity-75 tabular-nums">{counts[cat]}</span>
              </button>
            );
          })}
          {failedCommands > 0 && (
            <button
              type="button"
              onClick={jumpToNextFailed}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/12 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              title={t('Jump to next failed command')}
            >
              <AlertCircle className="size-3.5" />
              <span>{t('{n} failed', { n: failedCommands })}</span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-44 sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('Filter steps…')}
              aria-label={t('Filter steps…')}
              className="h-7 pr-7 pl-7 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('Clear filter')}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {entries.length < total
                ? t('{shown} of {total} steps', { shown: entries.length, total })
                : t('{n} steps', { n: total })}
              {dropped > 0 ? ` · ${t('{n} dropped', { n: dropped })}` : ''}
            </span>
            {live && (
              <span className="inline-flex items-center gap-1">
                <span className={cn('size-1.5 rounded-full', connected ? 'live-dot bg-success' : 'bg-warning')} />
                <span>{connected ? t('following') : t('connecting…')}</span>
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const next = !follow;
                setFollow(next);
                if (next) scrollToEnd();
              }}
            >
              {follow ? (
                <>
                  <Pause className="size-3.5" />
                  {t('Pause')}
                </>
              ) : (
                <>
                  <Play className="size-3.5" />
                  {t('Follow')}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable virtualized timeline */}
      <div
        ref={parentRef}
        onScroll={onScroll}
        className="h-[calc(100vh-19rem)] min-h-80 max-h-[68vh] overflow-y-auto px-3 py-3"
      >
        {(nextCursor !== undefined || dropped > 0) && (
          <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
            {dropped > 0 && nextCursor === undefined && (
              <Badge tone="outline">{t('{n} earlier log or reasoning entries were dropped', { n: dropped })}</Badge>
            )}
            {nextCursor !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loadingEarlier}
                onClick={() => void loadEarlier()}
                className="h-7 text-xs"
              >
                {loadingEarlier ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronUp className="size-3.5" />}
                {t('Load earlier')}
              </Button>
            )}
          </div>
        )}

        {!first.data && !first.isError && (
          <div className="py-8 text-center text-xs text-muted-foreground">{t('Loading…')}</div>
        )}

        {first.data && entries.length === 0 && (
          <Empty>{live ? t('Waiting for the first event…') : t('Transcript is empty.')}</Empty>
        )}

        {first.data && entries.length > 0 && filtered.length === 0 && (
          <Empty>{t('No steps match the current filter.')}</Empty>
        )}

        {filtered.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map(row => {
              const item = filtered[row.index];
              if (!item) return null;
              return (
                <div
                  key={item.seq}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="pb-2.5"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <TranscriptEntryCard
                    entry={item}
                    live={live}
                    highlighted={focusedSeq === item.seq}
                    fallbackUsage={runUsage}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!follow && filtered.length > 0 && (
        <div className="pointer-events-none absolute right-5 bottom-4 flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFollow(true);
              scrollToEnd();
            }}
            className="pointer-events-auto h-8 shadow-md"
          >
            <ArrowDownToLine className="size-3.5" />
            {t('Jump to latest')}
          </Button>
        </div>
      )}
    </div>
  );
}
