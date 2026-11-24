import { statusColor, commitAgeClass } from '@/components/StatusPalette';
import { UsageTile } from '@/components/Usage';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { OverviewAll, OverviewDay, Worker } from '@api';
import { Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useOverviewAll } from '@/lib/queries';
import { ago, dateTime, minutes } from '@/lib/format';
import { monitorResultLabel, stepText } from '@/lib/monitoring';
import { stageLabel } from '@/lib/stages';
import { attentionLabel, attentionPath, attentionProjects, mergeTotal, orderPath, OVERVIEW_CAPS as CAPS, projectPath, STAGE_ORDER } from '@/lib/overview';
import { cn } from '@/lib/utils';
import { UnknownTotal, SectionBoundary } from '@/components/common';
import { t } from '@/i18n';
import { LiveCommand } from '@/components/LivePanel';
import { SERIES_COLORS } from '@/lib/palette';
import { CountUp } from '@/components/motion';

const COLORS = SERIES_COLORS;
const outcomeLabels = () => ({ completed: t('Completed'), failed: t('Failed'), stalled: t('Stalled runs'), capacity: t('Capacity'), cancelled: t('Cancelled') });
const full = (list: string) => `/overview/${list}`;
const hours = (value?: number) => value === undefined ? '—' : t('{n} h', { n: Number(value.toFixed(1)) });

function More({ n, to }: { n: number; to: string }) {
  return n > 0 ? <Link className="overview-more" to={to}>{t('+{n} more', { n })}</Link> : null;
}
function Panel({ title, to, count, className, children }: { title: string; to: string; count?: number; className?: string; children: ReactNode }) {
  return <section className={cn('overview-panel', className)}><div className="overview-panel-heading"><Link to={to}>{title}</Link>{count !== undefined && <Link className="text-xs text-muted-foreground tabular-nums" to={to}>{count}</Link>}</div><div className="overview-panel-body"><SectionBoundary title={title}>{children}</SectionBoundary></div></section>;
}
function LiveRows({ o, cap }: { o: OverviewAll; cap: number }) {
  return <>{o.live.items.slice(0, cap).map(r => <div className="overview-row scanline" key={`${r.project}:${r.tag}`}>
    <div className="flex min-w-0 items-center gap-2"><Link className="overview-tag" to={orderPath(r.project, r.tag)}>{r.project}·{r.tag}</Link><Link className="truncate" to={r.run ? `${orderPath(r.project, r.tag)}/runs/${encodeURIComponent(r.run.id)}` : orderPath(r.project, r.tag)}>{r.title}</Link></div>
    {r.live && <div className="mt-1 truncate text-xs"><LiveCommand live={r.live} /></div>}
    <div className="overview-meta"><span>{r.run?.worker ?? r.worker}</span><span>{ago(r.run?.started ?? r.monitor?.started ?? r.updated)}</span>{stepText(r.progress) && <span className="text-foreground" title={r.progress?.current}>{stepText(r.progress)}</span>}
      {r.run && <span className={commitAgeClass(r.commitMinutes)}>{r.commitMinutes === undefined ? t('Commit time unknown') : t('{n} min without a commit', { n: r.commitMinutes })}</span>}
      {r.monitor && <><span>{t('{n} checks', { n: r.monitor.checks })} · {monitorResultLabel(r.monitor.lastResult)}{r.monitor.lastCheckAt && ` · ${dateTime(r.monitor.lastCheckAt)}`}</span><span>{t('deadline in {time}', { time: minutes(Math.max(0, Math.ceil((Date.parse(r.monitor.deadline) - Date.parse(o.at)) / 60000))) })}</span></>}
      {r.leases.map(l => <Link key={l.resource} className={cn(l.expired && 'text-destructive')} to={`${projectPath(r.project)}/workers`}>{l.resource} · {minutes(l.heldMinutes)}</Link>)}
    </div>
  </div>)}<More n={o.live.items.length - cap} to={full('live')} /></>;
}
function ProjectRows({ o, cap }: { o: OverviewAll; cap: number }) {
  const nonempty = o.projects.filter(p => p.total > 0);
  const empty = o.projects.length - nonempty.length;
  return <>{nonempty.slice(0, cap).map(p => <div className="overview-row" key={p.project}>
    <div className="flex items-center justify-between gap-2"><Link className="font-semibold" to={projectPath(p.project)}>{p.name}</Link><Link className="text-xs tabular-nums" to={`${projectPath(p.project)}/board?stage=merged`}>{p.stages.merged ?? 0}/{p.total} · {Math.round(100 * (p.stages.merged ?? 0) / p.total)}%</Link></div>
    <div className="overview-stage-bar">{STAGE_ORDER.filter(s => p.stages[s]).map(s => <Link key={s} style={{ background: statusColor(s), flex: p.stages[s] }} title={`${stageLabel(s)}: ${p.stages[s]}`} aria-label={`${p.name} · ${stageLabel(s)}: ${p.stages[s]}`} to={`${projectPath(p.project)}/board?stage=${s}`} />)}</div>
    <div className="flex items-center gap-3"><div className="flex h-5 w-28 items-end gap-0.5" aria-label={t('Merges per day')}>{p.mergesPerDay.map((n, i) => <Link key={i} to={`${projectPath(p.project)}/board?stage=merged`} className="flex-1 rounded-t-sm bg-success/70" style={{ height: `${Math.max(8, 100 * n / Math.max(1, ...p.mergesPerDay))}%` }} title={`${o.days[i].day}: ${n}`} />)}</div><Link className="text-xs text-warning" to={projectPath(p.project)}>{t('{n} need you', { n: p.needsCount })}</Link><Link className="text-xs text-primary" to={`${projectPath(p.project)}/runs`}>{t('{n} running', { n: p.running.items.length })}</Link></div>
    {p.next.moves[0] && <Link className="mt-1 block truncate text-[11px] text-muted-foreground" to={`${projectPath(p.project)}/tick`}>{t('Next tick')}: {p.next.moves[0].tag} · {p.next.moves[0].worker}</Link>}
    {p.error && <p className="mt-1 truncate text-xs text-destructive" title={p.error}>{p.error}</p>}
  </div>)}<More n={nonempty.length - cap} to={full('projects')} />{empty > 0 && <Link className="overview-more text-muted-foreground" to={full('projects')}>{t('{n} projects without orders', { n: empty })}</Link>}</>;
}
function WorkerRow({ w, project }: { w: Worker & { balanceChange24h?: number }; project?: string }) {
  return <Link className="overview-row block" to={project ? `${projectPath(project)}/workers` : '/'}>
    <div className="flex items-center gap-2"><span className={cn('size-2 shrink-0 rounded-full', w.available ? 'bg-success' : 'bg-destructive')} /><span className="font-medium">{w.id}</span>{w.host && <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground" title={t('Runs on {host} over SSH', { host: w.host })}>@{w.host}</span>}<span className="ml-auto text-[11px] tabular-nums">{w.running}/{w.concurrency} · {w.runsToday}/{w.dailyRuns ?? '∞'}</span></div>
    {!w.available && w.reasons[0] && <div className="mt-0.5 truncate text-[11px] text-destructive" title={w.reasons[0]}>{w.reasons[0]}</div>}
    <div className="overview-meta"><span>{w.quota?.balance?.raw ?? '—'}{w.balanceChange24h !== undefined ? ` (${w.balanceChange24h > 0 ? '+' : ''}${Number(w.balanceChange24h.toFixed(2))})` : ''}</span><span>{t('today ${spent} / {cap}', { spent: w.spendTodayUsd.toFixed(2), cap: w.dailyCapUsd === undefined ? '∞' : `$${w.dailyCapUsd}` })}</span></div>
  </Link>;
}
function Workers({ o, cap }: { o: OverviewAll; cap: number }) {
  const shown = o.workers.items.slice(0, cap);
  const sources = [...new Set(shown.map(w => w.quotaSource ?? `:${w.id}`))];
  return <>{sources.map(source => {
    const members = shown.filter(w => (w.quotaSource ?? `:${w.id}`) === source);
    const q = o.quotas.find(q => q.source === source)?.reading;
    const window = q?.windows.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return <div key={source}>{window && <div className="pt-2 text-[11px]"><div className="flex justify-between gap-2"><span className="truncate">{source} · {window.name}</span><span>{Math.round(window.usedPercent)}%</span></div><div className="my-1 h-1 rounded bg-muted"><div className={cn('h-full rounded', window.usedPercent >= 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }} /></div>{window.resetsAt && <span className="text-muted-foreground">{t('resets {when}', { when: dateTime(window.resetsAt) })}</span>}</div>}{members.map(w => <WorkerRow key={w.id} w={w} project={o.projects[0]?.project} />)}</div>;
  })}<More n={o.workers.items.length - cap} to={full('workers')} /><div className="mt-2 text-[10px] text-muted-foreground">{t('running / slots · runs today / daily limit · balance change over 24 h')}</div>{o.machine && <p className={cn('mt-2 border-t pt-2 text-xs', o.machine.freeRamGb !== undefined && o.machine.minFreeRamGb !== undefined && o.machine.freeRamGb < o.machine.minFreeRamGb ? 'text-destructive' : 'text-muted-foreground')}>{t('Free memory {free} GB / minimum {min} GB', { free: o.machine.freeRamGb ?? '—', min: o.machine.minFreeRamGb ?? '—' })}</p>}</>;
}
function MergeRows({ o, cap }: { o: OverviewAll; cap: number }) {
  return <>{o.recentMerges.items.slice(0, cap).map((m, i) => <Link className="overview-row block" key={`${m.project}:${m.tag}:${i}`} to={orderPath(m.project, m.tag)}><div className="flex min-w-0 items-center gap-2"><span className="overview-tag">{m.project}·{m.tag}</span><span className="truncate">{m.title}</span><span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{ago(m.at)}</span></div><div className="overview-meta"><span>{t('{n} runs', { n: m.runs })} · {t('{n} reworks', { n: m.reworks })}</span><span>{m.worker ?? '—'}</span><span>{hours(m.leadHours)}</span></div></Link>)}<More n={o.recentMerges.items.length - cap} to={full('merges')} /></>;
}
function Resources({ o, cap }: { o: OverviewAll; cap: number }) {
  return <>{o.resources.slice(0, cap).map(r => <div className="overview-row" key={`${r.project}:${r.name}`}><Link className="flex justify-between gap-2" to={`${projectPath(r.project)}/workers`}><span className="truncate">{r.project}·{r.name}</span><span>{r.used}/{r.slots}</span></Link>{r.leases.slice(0, 3).map(l => <Link className={cn('mt-1 block text-[11px]', l.expired ? 'text-destructive' : 'text-muted-foreground')} key={l.tag} to={orderPath(r.project, l.tag)}>{l.tag} · {minutes(l.heldMinutes)}{l.expired && ` · ${t('Expired lease')}`}</Link>)}<More n={r.leases.length - 3} to={`${projectPath(r.project)}/workers`} /></div>)}<More n={o.resources.length - cap} to={full('resources')} /></>;
}
function Next({ o, cap }: { o: OverviewAll; cap: number }) {
  return <>{o.next.moves.slice(0, cap).map(m => <Link className="overview-row block" key={`${m.project}:${m.tag}`} to={`${projectPath(m.project)}/tick`}><span className="overview-tag">{m.project}·{m.tag}</span><span className="ml-2">{m.mode === 'card' ? t('Waiting for your click') : m.mode === 'resume' ? t('Resume') : t('Start')} · {m.worker}</span></Link>)}<More n={o.next.moves.length - cap} to={full('next')} />{o.next.heldBack.slice(0, cap).map(h => <Link className="overview-row block" key={`${h.project}:${h.tag}`} to={`${projectPath(h.project)}/tick`}><span className="overview-tag">{h.project}·{h.tag}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground" title={h.why}>{h.why}</span></Link>)}<More n={o.next.heldBack.length - cap} to={full('next')} />{o.next.lastTickAt && <p className="mt-2 text-[11px] text-muted-foreground">{t('Last tick {when}', { when: ago(o.next.lastTickAt) })}</p>}</>;
}
function Charts({ o }: { o: OverviewAll }) {
  const totals = o.days.map(d => Object.values(d.merges).reduce((a, b) => a + b, 0));
  const top = Math.max(1, ...totals);
  const endingTop = Math.max(1, ...o.days.map(d => Object.values(d.endings).reduce((a, b) => a + b, 0)));
  const series = o.projects.filter(p => o.days.some(d => d.merges[p.project]));
  const endings = outcomeLabels();
  const barTitle = (d: OverviewDay) => `${d.day} · ${series.map(p => `${p.name}: ${d.merges[p.project] ?? 0}`).join(' · ')}`;
  return <><div className="grid grid-cols-2 gap-x-5 gap-y-3 pb-3"><div><strong className="text-2xl font-semibold tabular-nums"><CountUp value={o.metrics.merges7d} /></strong><p className="text-[11px] text-muted-foreground">{t('Merges in 7 days')}</p></div><div><strong className="text-2xl font-semibold tabular-nums">{o.metrics.runSuccessRate === undefined ? '—' : <><CountUp value={Math.round(o.metrics.runSuccessRate * 100)} />%</>}</strong><p className="text-[11px] text-muted-foreground">{t('Run success rate')}</p></div><div><strong className="text-lg tabular-nums">{o.metrics.reworksPerMerge?.toFixed(2) ?? '—'}</strong><p className="text-[11px] text-muted-foreground">{t('Reworks per merge')}</p></div><div><strong className="text-lg tabular-nums">{hours(o.metrics.medianLeadHours)}</strong><span className="ml-2 text-[11px] text-muted-foreground">{t('p95 {time}', { time: hours(o.metrics.p95LeadHours) })}</span><p className="text-[11px] text-muted-foreground">{t('Median queue → merge')}</p></div></div>
    <div className="flex h-24 items-end gap-1.5" role="img" aria-label={t('Merges per day')}>{o.days.map((d, i) => <Link key={d.day} to={full('merges')} title={barTitle(d)} className="flex h-full min-w-0 flex-1 flex-col justify-end"><div className="flex flex-col-reverse overflow-hidden rounded-t" style={{ height: `${100 * totals[i] / top}%`, minHeight: 2 }}>{series.map((p, j) => <span key={p.project} style={{ background: COLORS[j % COLORS.length], flex: d.merges[p.project] ?? 0 }} />)}</div></Link>)}</div>
    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{o.days[0]?.day.slice(5)}</span><span>{t('Today')} · UTC</span></div>
    <div className="mt-2 flex h-5 items-end gap-1.5" role="img" aria-label={t('Run endings by outcome')}>{o.days.map(d => <div key={d.day} className="flex min-h-px flex-1 flex-col-reverse" title={`${d.day} · ${Object.entries(d.endings).map(([k, n]) => `${endings[k as keyof typeof endings]}: ${n}`).join(' · ')}`}>{Object.entries(d.endings).map(([k, n]) => <div key={k} style={{ height: `${20 * n / endingTop}px`, background: k === 'completed' ? '#22a58c' : k === 'capacity' ? '#f5bb57' : '#ed6b73' }} />)}</div>)}</div>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">{series.slice(0, 6).map((p, i) => <Link key={p.project} to={`${projectPath(p.project)}/board?stage=merged`}><span className="mr-1 inline-block size-1.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />{p.name}</Link>)}<More n={series.length - 6} to={full('projects')} /></div>
    <p className="mt-1 text-[10px] text-muted-foreground">{t('Run endings: green completed · amber capacity · red other')}</p>
  </>;
}

function greeting(at: string): string {
  const hour = new Date(at).getHours();
  return hour < 5 ? t('Working through the night') : hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
}

export function OverviewPage() {
  const q = useOverviewAll();
  const [params, setParams] = useSearchParams();
  if (q.isError) return <UnknownTotal error={q.error} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const o = q.data;
  const selected = o.attention.find(g => g.kind === params.get('attention'));
  return <div><div className="mb-5 flex flex-wrap items-end justify-between gap-2"><div><div className="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">{t('All projects')}</div><h1 className="dawn-text mt-1 w-fit text-[26px] leading-tight font-semibold tracking-[-0.02em]">{greeting(o.at)}</h1></div><span className="text-xs text-muted-foreground">{t('read {when}', { when: ago(o.readingsAt ?? o.at) })}</span></div>
    <div className="overview-grid stagger">
      <div className="overview-attention">{o.attention.length ? o.attention.map(g => {
        const projects = attentionProjects(g);
        return <Link key={g.kind} className={cn('overview-chip', g.problem ? 'bg-destructive/10 text-destructive' : 'bg-warning/12 text-warning')} to={projects.length === 1 ? projectPath(projects[0]) : `/?attention=${encodeURIComponent(g.kind)}`}>{attentionLabel(g.kind)} <strong>{g.count}</strong></Link>;
      }) : <span className="text-sm text-success">✓ {t('Nothing needs you')}</span>}</div>
      <SectionBoundary title={t('Usage')}><UsageTile data={o.usage} /></SectionBoundary>
      {o.live.items.length > 0 && <Panel title={t('Live runs')} count={o.live.count} to={full('live')} className="overview-live"><LiveRows o={o} cap={CAPS.live} /></Panel>}
      {o.projects.length > 0 && <Panel title={t('Projects')} count={o.projects.length} to={full('projects')} className="overview-projects"><ProjectRows o={o} cap={CAPS.projects} /></Panel>}
      {o.workers.items.length > 0 && <Panel title={t('Workers and quota')} count={o.workers.count} to={full('workers')} className="overview-workers"><Workers o={o} cap={CAPS.workers} /></Panel>}
      {(mergeTotal(o) > 0 || o.days.some(d => Object.keys(d.endings).length || d.reworks)) && <Panel title={t('Throughput · 14 days')} to={full('merges')} className="overview-throughput"><Charts o={o} /></Panel>}
      {o.recentMerges.items.length > 0 && <Panel title={t('Recent merges')} count={o.recentMerges.count} to={full('merges')} className="overview-merges"><MergeRows o={o} cap={CAPS.merges} /></Panel>}
      <div className="overview-side">{o.resources.length > 0 && <Panel title={t('Resources and leases')} count={o.resources.length} to={full('resources')}><Resources o={o} cap={CAPS.resources} /></Panel>}{(o.next.moves.length > 0 || o.next.heldBack.length > 0 || o.next.lastTickAt) && <Panel title={t('Next tick')} to={full('next')}><Next o={o} cap={CAPS.moves} /></Panel>}</div>
    </div>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setParams({}); }}><DialogContent><DialogTitle>{selected && attentionLabel(selected.kind)}</DialogTitle><DialogDescription>{t('Open an order to act on it.')}</DialogDescription>{selected?.items.slice(0, CAPS.attention).map((i, n) => <Link key={n} to={attentionPath(i)} className="overview-row block"><span className="overview-tag">{i.project}{i.tag && `·${i.tag}`}</span><span className="mt-1 block text-sm">{i.text}</span></Link>)}{selected && <More n={selected.items.length - CAPS.attention} to={`${full('attention')}?kind=${encodeURIComponent(selected.kind)}`} />}</DialogContent></Dialog>
  </div>;
}

export function OverviewListPage() {
  const q = useOverviewAll();
  const { list } = useParams();
  const [params] = useSearchParams();
  if (q.isError) return <UnknownTotal error={q.error} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const o = q.data;
  return <div className="mx-auto max-w-5xl"><Link to="/" className="mb-4 block text-sm text-primary">← {t('Overview')}</Link>
    {list === 'live' && <Panel title={t('Live runs')} count={o.live.count} to={full('live')}><LiveRows o={o} cap={o.live.count} /></Panel>}
    {list === 'projects' && <Panel title={t('Projects')} count={o.projects.length} to={full('projects')}><ProjectRows o={o} cap={o.projects.length} />{o.projects.filter(p => p.total === 0).map(p => <Link className="overview-row block" key={p.project} to={projectPath(p.project)}>{p.name}</Link>)}</Panel>}
    {list === 'workers' && <Panel title={t('Workers and quota')} count={o.workers.count} to={full('workers')}><Workers o={o} cap={o.workers.count} /></Panel>}
    {list === 'merges' && <Panel title={t('Recent merges')} count={o.recentMerges.count} to={full('merges')}><MergeRows o={o} cap={o.recentMerges.count} /></Panel>}
    {list === 'resources' && <Panel title={t('Resources and leases')} count={o.resources.length} to={full('resources')}><Resources o={o} cap={o.resources.length} /></Panel>}
    {list === 'next' && <Panel title={t('Next tick')} to={full('next')}><Next o={o} cap={Math.max(o.next.moves.length, o.next.heldBack.length)} /></Panel>}
    {list === 'attention' && o.attention.filter(g => !params.get('kind') || params.get('kind') === g.kind).map(g => <Panel key={g.kind} title={attentionLabel(g.kind)} to={full('attention')} count={g.count}>{g.items.map((i, n) => <Link className="overview-row block" key={n} to={attentionPath(i)}><span className="overview-tag">{i.project}{i.tag && `·${i.tag}`}</span> · {i.text}</Link>)}</Panel>)}
  </div>;
}
