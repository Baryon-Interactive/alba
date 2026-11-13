import { useState } from 'react';
import { Link } from 'react-router';
import { Activity, ChevronRight } from 'lucide-react';
import type { ProducerLog, ProducerLogRow, ProducerNow } from '@api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty, ErrorBox, TagLink } from '@/components/common';
import { Skeleton } from '@/components/ui/misc';
import { useProducerLog } from '@/lib/queries';
import { activityRows, activityVerb, groupActivity } from '@/lib/producer-activity';
import { dateTime } from '@/lib/format';
import { getLang, t } from '@/i18n';
import { IndependentCheck, checkVerdict } from './IndependentCheck';

const budgetLabels: Record<string, string> = { escalations_per_day: 'Escalations per day', turns_per_hour: 'Turns per hour', usage_per_day: 'Usage per day', review_runs_per_day: 'Review runs per day', draft_runs_per_day: 'Draft runs per day' };

function nowText(now: ProducerNow): string {
  switch (now.state) {
    case 'thinking': return t('Thinking about {case} since {time}', { case: now.cases.map(c => t(c.summary)).join('; ') || t('Current case not recorded'), time: now.since ? dateTime(now.since) : t('Not recorded') });
    case 'paused': return t('Paused because {reason}', { reason: t(now.reason || 'Reason not recorded') });
    case 'budget-exhausted': return t('Budget exhausted until {time}', { time: now.until ? dateTime(now.until) : t('Not recorded') });
    case 'error': return now.retryAt ? t('Session error: {reason} · will retry at {time}', { reason: now.reason || t('Reason not recorded'), time: new Date(now.retryAt).toLocaleTimeString(getLang() === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) }) : t('Session error: {reason}', { reason: now.reason || t('Reason not recorded') });
    case 'recovering': return t(now.reason || 'Recovering after host restart');
    case 'stopped': return t('Idle · session stopped');
    case 'starting': return t('Starting session');
    case 'disabled': return t('Producer disabled');
    default: return t('Idle, starts when needed');
  }
}

export function ProducerNowLine({ now, project }: { now: ProducerNow; project: string }) {
  return <div data-producer-now><div className="flex items-start gap-2 text-sm font-medium"><span className={`mt-1 size-2 shrink-0 rounded-full ${now.state === 'thinking' ? 'animate-pulse bg-primary' : now.state === 'paused' || now.state === 'budget-exhausted' ? 'bg-warning' : 'bg-muted-foreground'}`} /><span className="break-words">{nowText(now)}</span></div>
    <p className="mt-1 pl-4 text-xs text-muted-foreground" data-session-wanted={now.wanted ? 'yes' : 'no'}>{t('Session wanted')}: {now.wanted ? t('yes') : t('no')} · {t('Last automatic restart')}: {now.lastRestartedAt ? dateTime(now.lastRestartedAt) : t('Not recorded')}</p>
    {!!now.cases.length && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-4 text-xs text-muted-foreground">{now.cases.map(c => <span key={c.key} className="flex flex-wrap items-center gap-2"><span>{t('Case')}: {t(c.key)}</span>{c.order && <TagLink project={project} tag={c.order} />}</span>)}</div>}
  </div>;
}

export function ProducerNowPanel({ now, project }: { now: ProducerNow; project: string }) {
  return <Card className="p-4" data-testid="producer-now"><div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 text-sm font-semibold"><Activity className="size-4 text-primary" />{t('Now')}</h2><span className="text-xs text-muted-foreground">{t('Updates every 5 seconds')}</span></div>
    <ProducerNowLine now={now} project={project} />
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 pl-4 text-xs text-muted-foreground"><span>{t('Last turn')}: {now.lastTurnAt ? dateTime(now.lastTurnAt) : t('Not recorded')}</span><span>{t('Next scheduled round')}: {now.nextRoundAt ? dateTime(now.nextRoundAt) : t('Not scheduled')}</span></div>
    <div className="mt-4 grid gap-4 border-t pt-3 sm:grid-cols-2 xl:grid-cols-4">{now.budgets.map(b => {
      const percent = b.used === undefined || b.limit === undefined ? 0 : b.limit === 0 ? 100 : Math.min(100, 100 * b.used / b.limit);
      return <div key={b.key}><div className="mb-1.5 flex items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">{t(budgetLabels[b.key] ?? b.key)}</span><span className="tabular-nums">{`${b.used === undefined ? t('Not recorded') : b.used.toLocaleString()} / ${b.limit === undefined ? t('No limit') : b.limit.toLocaleString()}`}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role={b.used !== undefined && b.limit !== undefined ? 'progressbar' : undefined} aria-label={t(budgetLabels[b.key] ?? b.key)} aria-valuemin={0} aria-valuemax={b.limit} aria-valuenow={b.used}><div className={`h-full rounded-full ${percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-warning' : 'bg-primary/70'}`} style={{ width: `${percent}%` }} /></div>
        <div className="mt-1 text-[11px] text-muted-foreground">{t('Resets {time}', { time: dateTime(b.resetsAt) })}</div>
      </div>;
    })}</div>{now.usage && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground" data-testid="budget-breakdown">
      {([['Uncached input', now.usage.uncachedInput], ['Cache read', now.usage.cacheRead], ['Cache write', now.usage.cacheWrite], ['Output', now.usage.output]] as const).map(([label, count]) => <span key={label}>{t(label)}: <b className="font-medium tabular-nums text-foreground">{count.toLocaleString()}</b></span>)}
      <span>{t('Cache hit rate')}: <b className="font-medium text-foreground">{(now.usage.cacheHitRate * 100).toFixed(1)}%</b></span><span>{t('Priced usage')}: ${now.usage.costUsd.toFixed(4)}</span>
      {!!now.usage.unpricedTokens && <span>{t('Unpriced tokens')}: {now.usage.unpricedTokens.toLocaleString()}</span>}
    </div>}{!!now.usageDays?.length && <div className="mt-4 overflow-x-auto border-t pt-3" data-testid="model-usage"><h3 className="mb-2 text-xs font-semibold">{t('Daily usage by engine and model')}</h3><table className="w-full whitespace-nowrap text-left text-xs"><thead className="text-muted-foreground"><tr>{['UTC day', 'Engine', 'Model', 'Requests', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Cache hit rate', 'Priced usage'].map(label => <th key={label} className="px-2 py-2 font-medium first:pl-0">{t(label)}</th>)}</tr></thead><tbody>{now.usageDays.map(row => <tr key={`${row.day}/${row.engine}/${row.model}`} className="border-t tabular-nums"><td className="py-2 pr-2">{row.day}</td><td className="px-2 py-2">{row.engine}</td><td className="px-2 py-2 font-medium">{row.model}</td>{[row.requests, row.uncachedInput, row.cacheRead, row.cacheWrite, row.output].map((n, i) => <td key={i} className="px-2 py-2">{n.toLocaleString()}</td>)}<td className="px-2 py-2 font-medium">{(row.cacheHitRate * 100).toFixed(1)}%</td><td className="px-2 py-2">{row.unpricedTokens ? `${t('Unpriced tokens')}: ${row.unpricedTokens.toLocaleString()}` : `$${row.costUsd.toFixed(4)}`}</td></tr>)}</tbody></table></div>}<p className="mt-2 text-[11px] text-muted-foreground">{t('Daily budgets reset at UTC midnight. Usage counts billed-equivalent tokens.')}</p>
  </Card>;
}

function RowHeading({ row, project }: { row: ProducerLogRow; project: string }) {
  const check = row.acceptance?.independent;
  const checkLink = row.order ? `/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(row.order)}#${check ? `independent-check-${check.id}` : 'acceptance'}` : '#';
  return <><time dateTime={row.at} title={dateTime(row.at)} className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{t(activityVerb(row))}</span>{row.status !== 'done' && <span className="text-muted-foreground">{t(row.kind)}</span>}{row.order && <TagLink project={project} tag={row.order} />}<Badge tone={row.mode === 'auto' ? 'primary' : 'neutral'}>{t(row.mode)}</Badge><Badge tone={row.status === 'done' ? 'success' : ['failed', 'refused'].includes(row.status) ? 'danger' : 'outline'}>{t(row.status)}</Badge>{row.claim && <Link to={checkLink}><Badge tone="warning" title={t('The note claims a verification. Open it to inspect the evidence.')} data-claim>{t('claim')}</Badge></Link>}</div>
      {check && <Link className="mt-1 block text-xs text-primary hover:underline" to={checkLink}>{t('checked by {worker}: {verdict}', { worker: check.worker, verdict: t(checkVerdict(check)) })} · {t('{n} items', { n: check.verdict?.checked.length ?? 0 })}</Link>}
      {row.reroute && <p className="mt-1 text-sm" data-testid="reroute-activity">{t('rerouted {order} from {from} to {to}: {reason}', { order: row.order ?? '', from: row.reroute.from, to: row.reroute.to, reason: row.note })}</p>}
      {!row.reroute && row.result && <p className={`mt-1 truncate text-xs ${row.status === 'failed' || row.status === 'refused' ? 'text-destructive' : 'text-muted-foreground'}`} title={row.result}>{row.result}</p>}
      {!row.reroute && row.firstLine && <p className="mt-1 truncate text-xs text-muted-foreground" title={row.firstLine}>{row.firstLine}</p>}
      {row.work && <p className="mt-1 text-xs text-muted-foreground">{t('Worker')}: {row.work.worker} · {t('Duration')}: {(row.work.durationMs / 1000).toFixed(1)}s · {t('Tokens')}: {row.work.tokens.toLocaleString()} · {t(row.work.status)}</p>}
    </div></>;
}

export function ProducerTimelineRow({ row, project }: { row: ProducerLogRow; project: string }) {
  return <><details className="group border-b last:border-0" data-activity-id={row.id} data-activity-kind={row.kind}>
    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 hover:bg-accent/30 [&::-webkit-details-marker]:hidden"><RowHeading row={row} project={project} /><ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" /></summary>
    <div className="space-y-3 border-t bg-muted/20 px-4 py-4 text-xs sm:pl-[6rem]">
      <div><h3 className="mb-1 font-semibold">{t('Full note')}</h3><p className="whitespace-pre-wrap break-words leading-relaxed">{row.note || t('No note recorded')}</p></div>
      {row.acceptance?.independent && <IndependentCheck run={row.acceptance.independent} />}
      <div><h3 className="mb-1 font-semibold">{t('Evidence')}</h3>{row.evidence.length ? <ul className="list-inside list-disc space-y-1 break-all font-mono">{row.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul> : <span className="text-muted-foreground">{t('No evidence recorded')}</span>}</div>
      {row.rule && <div className="break-words"><h3 className="mb-1 font-semibold">{t('Rule that allowed it')}</h3><p>{row.rule.id} · {row.rule.policyVersion}</p>{row.rule.instruction && <p className="mt-1 text-muted-foreground">{row.rule.instruction}</p>}</div>}
      {row.kind === 'accept' && <div className="grid gap-2 rounded-md border bg-card p-3 sm:grid-cols-2"><div><h3 className="mb-1 font-semibold">{t('Merge commit')}</h3><p className="break-all font-mono">{row.acceptance?.merge ?? t('Not recorded')}</p></div><div><h3 className="mb-1 font-semibold">{t('Design change-set step')}</h3><p>{row.acceptance?.designStep ? t(row.acceptance.designStep.status) : t('Not recorded')}</p>{row.acceptance?.designStep?.reason && <p className="mt-1">{row.acceptance.designStep.reason}</p>}{row.acceptance?.designStep?.files?.map(file => <p key={file} className="mt-1 break-all font-mono">{file}</p>)}</div></div>}
    </div>
  </details>{row.children?.map(child => <div key={child.id} className="ml-10 border-l bg-muted/10" data-work-child><ProducerTimelineRow row={child} project={project} /></div>)}</>;
}

export function ProducerActivityView({ log, project }: { log: ProducerLog; project: string }) {
  const [filters, setFilters] = useState({ kind: '', order: '', status: '', autonomous: false, superseded: false });
  const rows = activityRows(log.rows, filters), groups = groupActivity(rows);
  const select = (key: 'kind' | 'order' | 'status', label: string, options: string[]) => <label className="flex items-center gap-2 text-xs text-muted-foreground">{label}<select aria-label={label} className="h-8 max-w-48 rounded-md border bg-background px-2 text-foreground" value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}><option value="">{t('All')}</option>{options.map(option => <option key={option} value={option}>{key === 'order' ? option : t(option)}</option>)}</select></label>;
  return <div className="space-y-4" data-testid="producer-activity"><ProducerNowPanel now={log.now} project={project} />
    <section><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('Timeline')} <span className="ml-1 text-xs font-normal text-muted-foreground">{rows.length}</span></h2><span className="text-xs text-muted-foreground">{t('Times and days use your local timezone')}</span></div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border bg-card p-3">
        {select('kind', t('Kind'), [...new Set(log.rows.flatMap(r => [r.kind, ...(r.children?.map(c => c.kind) ?? [])]))].sort())}{select('order', t('Order'), [...new Set(log.rows.flatMap(r => r.order ? [r.order] : []))].sort())}{select('status', t('Status'), [...new Set(log.rows.map(r => r.status))].sort())}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={filters.autonomous} onChange={e => setFilters(f => ({ ...f, autonomous: e.target.checked }))} />{t('Only things it did on its own')}</label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={filters.superseded} onChange={e => setFilters(f => ({ ...f, superseded: e.target.checked }))} />{t('Show superseded')}</label>
      </div>
      {!groups.length && <Card className="p-4"><Empty>{t('No activity matches these filters.')}</Empty></Card>}
      {groups.map(g => <div key={g.day} className="mb-4" data-activity-day={g.day}><h3 className="mb-2 text-xs font-semibold text-muted-foreground">{new Date(g.at).toLocaleDateString(getLang() === 'zh' ? 'zh-CN' : 'en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</h3><Card className="overflow-hidden">{g.rows.map(row => <ProducerTimelineRow key={row.id} row={row} project={project} />)}</Card></div>)}
    </section></div>;
}

export function ProducerActivity({ project }: { project: string }) {
  const q = useProducerLog(project);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton className="h-64" />;
  return <ProducerActivityView log={q.data} project={project} />;
}

export function ProducerOverviewCard({ project }: { project: string }) {
  const q = useProducerLog(project);
  // The producer is an optional module: while it is off and has never acted, the overview stays quiet about it.
  if (q.data?.now.state === 'disabled' && !q.data.rows.length) return null;
  return <section className="overflow-hidden rounded-xl border bg-card" data-testid="producer-overview"><div className="flex items-center justify-between border-b px-4 py-2.5"><h2 className="text-sm font-semibold">{t('Producer')}</h2><Link className="text-xs text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/producer?tab=activity`}>{t('View activity')}</Link></div>
    {q.isError ? <div className="p-4"><ErrorBox error={q.error} /></div> : !q.data ? <Skeleton className="m-4 h-24" /> : <><div className="border-b p-4"><ProducerNowLine now={q.data.now} project={project} /></div><div>{q.data.rows.filter(r => r.status !== 'superseded').slice(0, 5).map(row => <div key={row.id} className="flex gap-3 border-b px-4 py-2.5 last:border-0"><RowHeading row={row} project={project} /></div>)}{!q.data.rows.length && <div className="p-4"><Empty>{t('No producer activity yet.')}</Empty></div>}</div></>}
  </section>;
}
