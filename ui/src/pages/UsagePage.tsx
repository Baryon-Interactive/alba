import { RoleResults } from '@/components/Roles';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { useProjectId, useWorkers } from '@/lib/queries';
import { WorkerQuota } from '@/components/CapacitySummary';
import { ErrorBox } from '@/components/common';
import { Skeleton } from '@/components/ui/misc';
import { UsageTable, tokenNumber, tokenTotal } from '@/components/Usage';
import { ConfigPanel, JsonSettings, configKey, useEditToggle } from '@/components/ConfigSections';
import { t } from '@/i18n';
import { SERIES_COLORS } from '@/lib/palette';

export function UsagePage() {
  const project = useProjectId(), [since, setSince] = useState('7d');
  const [editing, editButton] = useEditToggle();
  const workers = useWorkers(project);
  const q = useQuery({ queryKey: ['run-usage', project, since], queryFn: () => api.runUsage(project, since), refetchInterval: 30000 });
  // the budget and the usage warnings can be changed even when the usage cannot be read
  const settings = editing && <ConfigPanel project={project}>{view => <><JsonSettings key={configKey(view, ['budget'])} project={project} view={view} path={['budget']} title={t('Budget')} description={t('Tokens and cost a day and per order: tokens_per_day, tokens_per_order, cost_per_day, currency.')} /><JsonSettings key={configKey(view, ['usage_warnings'])} project={project} view={view} path={['usage_warnings']} title={t('Usage warnings')} description={t('When a run’s use of tokens is reported as waste.')} /></>}</ConfigPanel>;
  if (q.isError) return <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">{t('Usage and cost')}</h1>{editButton}</div>{settings}<ErrorBox error={q.error} /></div>;
  const d = q.data;
  const max = Math.max(1, ...d?.days.map(day => Object.values(day.projects).reduce((n,v) => n + v, 0)) ?? []);
  const colors = SERIES_COLORS;
  const names = d?.projects.rows.map(p => p.key) ?? [];
  return <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">{t('Usage and cost')}</h1><div className="flex items-center gap-3"><label className="flex items-center gap-2 text-sm">{t('Period')}<select className="rounded border bg-card px-3 py-1" value={since} onChange={e => setSince(e.target.value)}><option value="24h">{t('24 hours')}</option><option value="7d">{t('7 days')}</option><option value="30d">{t('30 days')}</option></select></label>{editButton}</div></div>{settings}{!d ? <Skeleton className="h-96" /> : <><section className="rounded-lg border bg-card p-4"><h2 className="mb-3 font-semibold">{t('Worker availability and quota')}</h2>{workers.data ? <WorkerQuota workers={workers.data.workers} /> : workers.isError ? <p className="text-sm text-muted-foreground">{t('Worker quota unavailable')}</p> : <p className="text-sm text-muted-foreground">{t('Loading worker quota…')}</p>}</section><section className="rounded-lg border bg-card p-4"><h2 className="font-semibold">{since === '7d' ? t('7-day token trend') : t('Daily tokens')}</h2><div className="mt-4 flex h-32 items-end gap-2 border-b pb-5">{d.days.map(day => { const sum = Object.values(day.projects).reduce((n,v) => n + v, 0); return <div className="relative flex min-w-0 flex-1 flex-col justify-end" style={{ height: '100%' }} key={day.day} title={`${day.day}: ${sum.toLocaleString()}`}><div className="flex flex-col-reverse overflow-hidden rounded-t" style={{ height: `${sum / max * 100}%`, minHeight: sum ? 2 : 0 }}>{names.map((name,i) => <div key={name} style={{ height: `${sum ? (day.projects[name] ?? 0) / sum * 100 : 0}%`, background: colors[i % colors.length] }} />)}</div><span className="absolute -bottom-5 w-full truncate text-center text-[10px] text-muted-foreground">{day.day.slice(5)}</span></div>; })}</div></section><div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"><span>{t('Total')}: <strong className="tabular-nums">{tokenTotal(d.workers.total)}</strong> {t('tokens')}</span><span className="text-muted-foreground">{t('Tokens per merged order')}: {t('Median')} {d.median === undefined ? '—' : tokenNumber(d.median)} · {t('90th percentile')} {d.p90 === undefined ? '—' : tokenNumber(d.p90)}</span></div><section className="rounded-lg border bg-card p-4"><h2 className="mb-3 font-semibold">{t('Results by role and worker')}</h2><RoleResults results={d.roles ?? []} /></section><UsageTable report={d.workers} title={t('Cached and reasoning shares by worker')} /><UsageTable report={d.orders} title={t('Top orders by tokens')} /><UsageTable report={d.mergedKinds} title={t('Cost per merged order by kind')} perOrder /><section className="rounded-lg border bg-card p-4"><h2 className="mb-2 font-semibold">{t('Usage warnings')}</h2>{d.warnings.map((w,i) => <p key={i} className="text-sm text-warning">{w.order && <Link to={`/p/${project}/orders/${w.order}`}>{w.order} · </Link>}{w.text}</p>)}{d.signals.map((s,i) => <p key={i} className="py-1 text-sm text-warning"><Link to={`/p/${project}/orders/${s.order}`}>{s.order} · {s.run}</Link> · {t('Turns')} {s.turns.join('–')} · {s.text}</p>)}{!d.warnings.length && !d.signals.length && <p className="text-sm text-muted-foreground">{t('No usage warnings')}</p>}</section></>}</div>;
}
