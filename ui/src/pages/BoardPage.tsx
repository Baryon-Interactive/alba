import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Clock, Search, X } from 'lucide-react';
import type { OrderSummary } from '@api';
import { commitAgeClass, statusColor } from '@/components/StatusPalette';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { SectionBoundary, ErrorBox, PageHeader, StageBadge } from '@/components/common';
import { OverlapWarning } from '@/components/ReadinessCard';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { useOrders, useProjectId } from '@/lib/queries';
import { BOARD_COLUMNS, stageLabel, waitingFor } from '@/lib/stages';
import { ago, minutes } from '@/lib/format';
import { monitorResultLabel, stepText } from '@/lib/monitoring';
import { cn } from '@/lib/utils';
import { RunStatus } from '@/components/RunStatus';
import { t } from '@/i18n';

import { RunPeek } from '@/components/RunPeek';
import { OrderQuestion } from '@/components/OrderQuestion';
import { MarkAllRead, MuteMenu, NewPill } from '@/components/OrderAttention';

const ALL = '';
const DONE_LIMIT = 12;

function distinct(items: OrderSummary[], pick: (o: OrderSummary) => string | undefined) {
  return [...new Set(items.map(pick).filter((x): x is string => !!x))].sort();
}

/** Tags of the other orders a running or awaiting-review order overlaps, once readiness has been read. */
function useOverlapTags(project: string, items: OrderSummary[]): Map<string, string[]> {
  const targets = items.filter(o => (o.stage === 'running' || o.stage === 'awaiting-review') && !!o.branch);
  const results = useQueries({
    queries: targets.map(o => ({
      queryKey: keys.readiness(project, o.tag),
      queryFn: () => api.readiness(project, o.tag),
      enabled: !!project,
      staleTime: 15_000,
      retry: false,
    })),
  });
  const map = new Map<string, string[]>();
  targets.forEach((o, i) => {
    const tags = results[i]?.data?.overlaps.map(x => x.tag) ?? [];
    if (tags.length > 0) map.set(o.tag, tags);
  });
  return map;
}

export function BoardCard({ project, o, overlapTags }: { project: string; o: OrderSummary; overlapTags?: string[] }) {
  const quiet = o.quietMinutes;
  return (
    <article
      className={`${o.unread ? 'order-unread ' : ''}${o.stage === 'running' && o.liveness === 'active' ? 'scanline live-glow ' : ''}relative block min-w-0 overflow-hidden rounded-xl border bg-card p-3.5 pt-4 transition-[transform,box-shadow,border-color] before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-[var(--stage)] hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--stage)_45%,var(--border))] hover:shadow-[0_6px_18px_-8px_rgb(20_24_58/0.35)]`}
      style={{ '--stage': statusColor(o.stage) } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 font-mono text-[13px] font-semibold">
          <Link className="truncate hover:underline after:absolute after:inset-0" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(o.tag)}`}>{o.tag}<span className="sr-only"> {o.title}</span></Link><NewPill unread={o.unread} />
          {overlapTags && overlapTags.length > 0 && <OverlapWarning tags={overlapTags} />}
        </span>
        <div className="relative flex items-center gap-1"><RunStatus {...o} /><StageBadge stage={o.stage} waitingFor={o.waitingFor} /><MuteMenu project={project} tag={o.tag} muted={o.muted} /></div>
      </div>
      <div className="order-title mt-1 line-clamp-2 min-h-10 text-sm break-words">{o.title}</div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
        {o.lintBounced && <Badge tone="warning">{t('Lint rework')}</Badge>}
        {o.kind && <Badge tone="outline">{o.kind}</Badge>}
        {o.heavy && <Badge tone="outline">{t('Heavy class {kind}', { kind: o.heavy })}</Badge>}
        {(o.run?.worker || o.nextWorker || o.worker) && <Badge tone="neutral">{o.run?.worker ?? (o.nextWorker ? `${t('Next worker')}: ${o.nextWorker}` : o.worker)}</Badge>}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{o.stage === 'planned' ? o.why : o.stage === 'waiting-needs' ? t('waiting for {tags}', { tags: o.needs.join(', ') }) : waitingFor(o.stage, o.waitingFor)}</span>
        {quiet !== undefined && (
          <span className={cn('inline-flex items-center gap-1 tabular-nums', commitAgeClass(quiet))}>
            <Clock className="size-3" />{minutes(quiet)}
          </span>
        )}
      </div>
      {stepText(o.progress) && <div className="mt-1 truncate text-xs" title={o.progress?.current}><span className="font-medium tabular-nums">{stepText(o.progress)}</span>{o.progress?.current && <span className="text-muted-foreground"> · {o.progress.current}</span>}</div>}
      {o.monitor && <div className="mt-1 truncate text-xs text-muted-foreground">{monitorResultLabel(o.monitor.lastResult)}{o.monitor.lastCheckAt ? ` · ${t('last {when}', { when: ago(o.monitor.lastCheckAt) })}` : ''}</div>}
      {o.uses && o.uses.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{o.uses.map(u => <Badge key={u} tone="outline" className="font-mono text-[10px]">{u}</Badge>)}</div>}
      {o.openCommand && <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">$ {o.openCommand}</div>}
      <OrderQuestion project={project} o={o} />
      {(o.run || o.stage === 'monitoring') && <RunPeek project={project} tag={o.tag} />}
    </article>
  );
}

export function BoardPage() {
  const project = useProjectId();
  const q = useOrders(project);
  const [params, setParams] = useSearchParams();
  const [showPlan, setShowPlan] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const get = (k: string) => params.get(k) ?? ALL;
  const set = (k: string, v: string) => setParams(p => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const items = q.data?.items ?? [];
  const overlapByTag = useOverlapTags(project, items);
  const filters = { stage: get('stage'), kind: get('kind'), heavy: get('heavy'), worker: get('worker'), text: get('q').trim().toLowerCase() };
  const unreadOnly = get('unread') === '1';
  const filtered = useMemo(
    () => items.filter(o =>
      (!unreadOnly || o.unread) && (!filters.stage || o.stage === filters.stage) && (!filters.kind || o.kind === filters.kind) && (!filters.heavy || o.heavy === filters.heavy) && (!filters.worker || (o.run?.worker ?? o.nextWorker ?? o.worker) === filters.worker)
      && (!filters.text || `${o.tag} ${o.title}`.toLowerCase().includes(filters.text))),
    [items, unreadOnly, filters.stage, filters.kind, filters.heavy, filters.worker, filters.text],
  );
  const active = !!(unreadOnly || filters.stage || filters.kind || filters.heavy || filters.worker || filters.text);
  const hideEmpty = get('empty') === 'hide';

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid grid-cols-7 gap-3"><Skeleton className="h-64" /><Skeleton className="h-64" /><Skeleton className="h-64" /></div>;

  const sel = (key: 'kind' | 'heavy' | 'worker', label: string, values: string[]) => (
    <Select value={get(key)} onChange={e => set(key, e.target.value)} className="w-44" aria-label={label}>
      <option value={ALL}>{label}</option>
      {values.map(v => <option key={v} value={v}>{v}</option>)}
    </Select>
  );

  return (
    <div>
      <PageHeader title={t('Board')} count={filtered.length}>{t('Stages are worked out from facts, so cards cannot be dragged. Use the actions on an order.')}</PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={get('q')} onChange={e => set('q', e.target.value)} placeholder={t('Search tag or title')} className="pl-8" />
        </div>
        {sel('kind', t('All kinds'), distinct(items, o => o.kind))}
        {filters.stage && <Badge tone="outline">{stageLabel(filters.stage as OrderSummary['stage'])}</Badge>}
        {sel('heavy', t('All heavy classes'), distinct(items, o => o.heavy))}
        {sel('worker', t('All workers'), distinct(items, o => o.run?.worker ?? o.nextWorker ?? o.worker))}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={hideEmpty} onChange={e => set('empty', e.target.checked ? 'hide' : '')} />{t('Hide empty columns')}</label>
        <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={unreadOnly} onChange={e => set('unread', e.target.checked ? '1' : '')} />{t('Unread only')}</label>
        <MarkAllRead project={project} />
        {active && <button onClick={() => setParams({}, { replace: true })} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><X className="size-3" />{t('Clear filters')}</button>}
      </div>
      <div className="stagger flex min-h-[60vh] items-start gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.filter(col => !hideEmpty || filtered.some(o => col.stages.includes(o.stage))).map(col => {
          const all = filtered.filter(o => col.stages.includes(o.stage));
          const rows = col.id === 'done' && !showAllDone ? [...all].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, DONE_LIMIT) : all;
          if (col.id === 'plan' && !showPlan && !filters.stage) return <button key={col.id} onClick={() => setShowPlan(true)} aria-expanded={false} className="flex w-32 shrink-0 items-center gap-2 rounded-lg border bg-muted/50 p-3 text-left text-xs text-muted-foreground"><ChevronRight className="size-4 shrink-0" /><span>{col.title()}<strong className="mt-1 block text-lg tabular-nums">{all.length}</strong></span></button>;
          return (
            <div key={col.id} className="flex min-w-[248px] flex-1 basis-[268px] flex-col overflow-hidden rounded-2xl border border-dashed border-border/70 bg-muted/35 p-2.5">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 px-1.5 pt-0.5">
                <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: statusColor(col.stages[0]) }} />{col.id === 'plan' ? <button className="flex items-center gap-1" onClick={() => { setShowPlan(false); if (filters.stage) set('stage', ''); }} aria-expanded={true}><ChevronDown className="size-4" />{col.title()}</button> : col.title()}</h2>
                <span className="rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{all.length}</span>
              </div>
              <div className="grid min-w-0 content-start gap-2">
                {rows.map(o => <SectionBoundary key={o.tag} title={o.tag}><BoardCard project={project} o={o} overlapTags={(o.stage === 'running' || o.stage === 'awaiting-review') ? overlapByTag.get(o.tag) : undefined} /></SectionBoundary>)}
                {all.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">{t('Empty')}</div>}
                {col.id === 'done' && all.length > DONE_LIMIT && (
                  <button onClick={() => setShowAllDone(s => !s)} className="py-1 text-xs text-primary hover:underline">
                    {showAllDone ? t('Show fewer') : t('Show all {n}', { n: all.length })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
