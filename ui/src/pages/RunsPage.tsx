import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { RunRow } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader, StageBadge, UsageText } from '@/components/common';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { useProjectId, useWorkers } from '@/lib/queries';
import { dateTime, duration, tokens } from '@/lib/format';
import { sumCost } from '@/lib/spend';
import { t } from '@/i18n';

const SINCE = { all: 0, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
type Since = keyof typeof SINCE;
const headers = () => [t('Order'), t('Run'), t('Worker'), t('Started'), t('Duration'), t('Outcome'), t('Usage')];
const outcomeLabel = (value: string) => ({ running: t('running'), completed: t('Completed'), failed: t('Failed'), stalled: t('Stalled'), capacity: t('Capacity'), cancelled: t('Cancelled') })[value] ?? value;

function RunLoading() {
  return <div><PageHeader title={t('Runs')}>{t('Loading runs; worker, duration and outcome will appear below.')}</PageHeader><Card className="overflow-x-auto" aria-busy="true"><table className="w-full min-w-[46rem] text-sm"><thead><tr className="border-b text-left text-xs text-muted-foreground">{headers().map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, i) => <tr key={i} className="border-b">{headers().map((h, j) => <td key={h} className="px-4 py-3"><Skeleton className={j === 0 ? 'h-4 w-40' : 'h-4 w-16'} /></td>)}</tr>)}</tbody></table></Card></div>;
}

/** Runs of every order of the project, newest first, from `GET /api/runs`; older pages are read when asked for. */
export function RunsPage() {
  const project = useProjectId();
  const workers = useWorkers(project);
  const [worker, setWorker] = useState('');
  const [outcome, setOutcome] = useState('');
  const [since, setSince] = useState<Since>('week');
  // The cut-off is fixed per choice, so the key (and the cache) stays the same while the page is open.
  const sinceIso = useMemo(() => (SINCE[since] ? new Date(Date.now() - SINCE[since]).toISOString().slice(0, 13) + ':00:00.000Z' : undefined), [since]);

  const q = useInfiniteQuery({
    queryKey: keys.runs(project, `${worker}|${sinceIso ?? ''}`),
    queryFn: ({ pageParam }) => api.runs(project, { worker: worker || undefined, since: sinceIso, limit: 100, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.next,
    enabled: !!project,
    staleTime: 15_000,
  });

  const rows: RunRow[] = useMemo(() => q.data?.pages.flatMap(p => p.items) ?? [], [q.data]);
  const shown = rows.filter(r => !outcome || (outcome === 'running' ? !r.ended : r.outcome === outcome));
  const cost = sumCost(shown.map(r => r.usage));
  const sumTokens = shown.reduce((n, r) => n + (r.usage.total_tokens ?? 0), 0);
  const workerIds = [...new Set([...(workers.data?.workers ?? []).map(w => w.id), ...rows.map(r => r.worker)])].sort();

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <RunLoading />;
  return (
    <div>
      <PageHeader title={t('Runs')} count={shown.length}>
        {tokens(sumTokens)} {t('tokens')} · <span className={cost.known ? undefined : 'text-muted-foreground'}>{cost.text}</span>
      </PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select value={since} onChange={e => setSince(e.target.value as Since)} className="w-40">
          <option value="day">{t('Last 24 hours')}</option><option value="week">{t('Last 7 days')}</option><option value="month">{t('Last 30 days')}</option><option value="all">{t('All time')}</option>
        </Select>
        <Select value={worker} onChange={e => setWorker(e.target.value)} className="w-40"><option value="">{t('All workers')}</option>{workerIds.map(w => <option key={w}>{w}</option>)}</Select>
        <Select value={outcome} onChange={e => setOutcome(e.target.value)} className="w-40"><option value="">{t('All outcomes')}</option>{['running', 'completed', 'failed', 'stalled', 'capacity', 'cancelled'].map(o => <option key={o} value={o}>{outcomeLabel(o)}</option>)}</Select>
      </div>
      {shown.length === 0 ? <Empty>{rows.length ? t('No runs match these filters. Change the period or outcome to see more.') : t('No runs yet. Queued orders appear here after a worker starts.')}</Empty> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-1.5 font-medium">{t('Order')}</th><th className="px-2 py-1.5 font-medium">{t('Run')}</th><th className="px-2 py-1.5 font-medium">{t('Worker')}</th><th className="px-2 py-1.5 font-medium">{t('Started')}</th><th className="px-2 py-1.5 font-medium">{t('Duration')}</th><th className="px-2 py-1.5 font-medium">{t('Outcome')}</th><th className="px-4 py-1.5 font-medium">{t('Usage')}</th>
            </tr></thead>
            <tbody className="divide-y">
              {shown.map(r => (
                <tr key={r.key} className="hover:bg-accent/40">
                  <td className="px-4 py-2"><Link className="font-mono text-[13px] font-semibold hover:underline" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(r.tag)}`}>{r.tag}</Link><span className="ml-2 text-muted-foreground">{r.title}</span> <StageBadge stage={r.stage} /></td>
                  <td className="px-2 py-2 font-mono text-[13px]">{r.hasLog ? <Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(r.tag)}/runs/${encodeURIComponent(r.id)}`}>{r.id}</Link> : r.id}</td>
                  <td className="max-w-56 truncate px-2 py-2" title={r.worker}>{r.worker}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">{dateTime(r.started)}</td>
                  <td className="px-2 py-2 whitespace-nowrap tabular-nums">{duration(r.started, r.ended)}</td>
                  <td className="px-2 py-2">{r.ended ? <Badge tone={r.outcome === 'completed' ? 'success' : r.outcome === 'cancelled' ? 'neutral' : 'danger'}>{r.limit === 'unreachable' ? t('endpoint unreachable') : outcomeLabel(r.outcome ?? '')}</Badge> : <Badge tone="primary"><Play />{t('running')}</Badge>}</td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap"><UsageText usage={r.usage} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {q.hasNextPage && <div className="mt-3 text-center"><Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? t('Loading…') : t('Older runs')}</Button></div>}
    </div>
  );
}
