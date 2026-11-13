import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import Anser from 'anser';
import { ArrowDownToLine, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorBox } from '@/components/common';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { openStream } from '@/lib/stream';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const MAX_LINES = 20_000;
const ROW = 18;

const Line = memo(function Line({ text }: { text: string }) {
  const parts = Anser.ansiToJson(text, { json: true, remove_empty: true, use_classes: false });
  if (parts.length === 0) return <>{' '}</>;
  return (
    <>
      {parts.map((p, i) => {
        const dec = p.decoration ?? '';
        return (
          <span
            key={i}
            style={{
              color: p.fg ? `rgb(${p.fg})` : undefined,
              backgroundColor: p.bg ? `rgb(${p.bg})` : undefined,
              fontWeight: dec.includes('bold') ? 600 : undefined,
              opacity: dec.includes('dim') ? 0.6 : undefined,
              textDecoration: dec.includes('underline') ? 'underline' : undefined,
            }}
          >
            {p.content}
          </span>
        );
      })}
    </>
  );
});

/**
 * The tail of a run's log, colored from the ANSI codes, drawn with a virtual list. It reads the last lines with a plain call and then
 * follows `run.log` events of its own stream connection. Scrolling up pauses following; the button (or scrolling to the end) resumes.
 */
export function LogViewer({ project, runKey, live }: { project: string; runKey: string; live: boolean }) {
  const first = useQuery({ queryKey: keys.runLog(project, runKey), queryFn: () => api.runLog(project, runKey, 1000), staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, retry: false });
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [connected, setConnected] = useState(false);
  const parent = useRef<HTMLDivElement>(null);
  const baseOffset = useRef(0);
  const programmatic = useRef(false);

  useEffect(() => {
    if (!first.data) return;
    baseOffset.current = first.data.offset;
    setLines(first.data.lines);
  }, [first.data]);

  useEffect(() => {
    if (!live || !first.data) return;
    const h = openStream({
      // `@offset`: the server sends everything written after the tail that was read, so no line falls between the two calls.
      project, logs: [`${runKey}@${first.data.offset}`],
      onState: s => setConnected(s === 'live'),
      onRunLog: e => {
        if (e.key !== runKey || e.offset <= baseOffset.current) return;
        baseOffset.current = e.offset;
        setLines(prev => { const next = prev.concat(e.lines); return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next; });
      },
    });
    return () => { h.close(); setConnected(false); };
  }, [live, project, runKey, first.data]);

  const v = useVirtualizer({ count: lines.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 30 });

  const toEnd = useCallback(() => {
    programmatic.current = true;
    if (lines.length) v.scrollToIndex(lines.length - 1, { align: 'end' });
    requestAnimationFrame(() => { programmatic.current = false; });
  }, [lines.length, v]);

  useLayoutEffect(() => { if (follow) toEnd(); }, [lines.length, follow, toEnd]);

  const onScroll = () => {
    const el = parent.current;
    if (!el || programmatic.current) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atEnd);
  };

  if (first.isError) return <ErrorBox error={first.error} />;
  return (
    <div className="overflow-hidden rounded-xl border bg-[oklch(0.18_0.01_258)] text-[oklch(0.9_0.005_250)] shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-[oklch(0.75_0.01_250)]">
        <div className="flex items-center gap-2">
          <span className="tabular-nums">{t('{n} lines', { n: lines.length })}{first.data?.cut ? ` · ${t('earlier lines cut')}` : ''}</span>
          {live && <span className="inline-flex items-center gap-1"><span className={cn('size-1.5 rounded-full', connected ? 'live-dot bg-success' : 'bg-warning')} />{connected ? t('following') : t('connecting…')}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[oklch(0.85_0.01_250)] hover:bg-white/10 hover:text-white" onClick={() => setFollow(f => !f)}>
            {follow ? <><Pause />{t('Pause')}</> : <><Play />{t('Follow')}</>}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[oklch(0.85_0.01_250)] hover:bg-white/10 hover:text-white" onClick={() => { setFollow(true); toEnd(); }}><ArrowDownToLine />{t('To the end')}</Button>
        </div>
      </div>
      <div ref={parent} onScroll={onScroll} className="h-[62vh] overflow-auto px-3 py-2">
        <div style={{ height: v.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
          {v.getVirtualItems().map(row => (
            <div key={row.index} className="log-line absolute left-0 w-full" style={{ top: 0, height: ROW, transform: `translateY(${row.start}px)` }}>
              <Line text={lines[row.index] ?? ''} />
            </div>
          ))}
        </div>
        {!first.data && !first.isError && <div className="text-xs text-[oklch(0.7_0.01_250)]">{t('Loading…')}</div>}
        {first.data && lines.length === 0 && <div className="text-xs text-[oklch(0.7_0.01_250)]">{t('(log is empty or missing)')}</div>}
      </div>
    </div>
  );
}
