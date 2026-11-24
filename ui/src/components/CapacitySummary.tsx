import { useEffect, useState } from 'react';
import { minutes } from '@/lib/format';
import type { CapacityUsage, Worker } from '@api';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { useProducer, useResources } from '@/lib/queries';
import { t } from '@/i18n';

export function WorkerQuota({ workers, compact = false }: { workers: Worker[]; compact?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{workers.map(w => <div key={w.id} className="min-w-0 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-1"><strong className="break-words">{w.id}</strong><span className={w.available ? 'text-primary' : 'text-muted-foreground'}>{w.available ? t('Available') : t('Unavailable')} · {w.running}/{w.concurrency}</span></div>
    {w.quota?.ok ? <div className={compact ? 'grid grid-cols-2 gap-x-3' : undefined}>{w.quota.windows.map(window => <div key={window.name} className="mt-1.5"><div className="mb-1 flex justify-between gap-2 text-muted-foreground"><span>{window.name}</span><span>{Math.round(window.usedPercent)}%</span></div><div role="progressbar" aria-label={`${w.id} · ${window.name}`} aria-valuenow={window.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={window.usedPercent >= 90 ? 'h-full bg-destructive' : window.usedPercent >= 80 ? 'h-full bg-warning' : 'h-full bg-primary'} style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }} /></div>{window.resetsAt && <span className="text-muted-foreground" title={window.resetsAt}>{t('Resets in {time}', { time: minutes(Math.max(0, Math.ceil((Date.parse(window.resetsAt) - now) / 60_000))) })}</span>}</div>)}{w.quota.windows.length === 0 && w.quota.note && <p className="mt-1 text-muted-foreground">{w.quota.note}</p>}</div> : <p className="mt-1 text-muted-foreground">{w.quota ? t('quota unreadable') : t('no quota source')}</p>}
    {w.quota?.balance && <p className="mt-1 text-muted-foreground">{t('Balance')}: {w.quota.balance.raw}</p>}
    {!w.available && w.reasons.length > 0 && <p className="mt-1 break-words text-muted-foreground">{w.reasons.join(' · ')}</p>}
    {w.sharesQuotaWith.length > 0 && <p className="mt-1 text-muted-foreground">{t('Shared quota with {workers}', { workers: w.sharesQuotaWith.join(',') })}</p>}
  </div>)}</div>;
}

export function CapacitySummary({ project, workers, capacity }: { project: string; workers: Worker[]; capacity: Record<string, CapacityUsage> }) {
  const resources = useResources(project);
  const producer = useProducer(project);
  const session = producer.data?.session;
  const state = session?.state;
  return <section className="rounded-lg border bg-card px-4 py-2.5">
    <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"><h2 className="text-sm font-semibold">{t('Console capacity')}</h2>
      {resources.data?.resources.map(r => <span key={r.name}>{r.name} <strong className="tabular-nums">{r.used}/{r.slots}</strong></span>)}
      {Object.entries(capacity).map(([kind, count]) => <span key={kind}>{kind} <strong className="tabular-nums">{count.used}/{count.cap}</strong> ({t('{n} monitoring', { n: count.monitoring })})</span>)}
      <Link to={`/p/${encodeURIComponent(project)}/producer`} className="ml-auto flex flex-wrap items-center gap-2 hover:underline">{t('Producer session')}<Badge tone={state === 'running' || state === 'starting' ? 'primary' : state === 'error' ? 'danger' : state === 'paused' ? 'warning' : 'neutral'}>{state ? t(state) : producer.isError ? t('Status unavailable') : t('Loading…')}</Badge>{producer.data && <span className="text-muted-foreground">{producer.data.enabled && !producer.data.paused ? t('Host active') : t('Host paused')}</span>}</Link>
    </div>
    <WorkerQuota workers={workers} compact />
    {resources.isError && <p className="mt-2 text-xs text-muted-foreground">{t('Resource capacity unavailable')}</p>}
  </section>;
}
