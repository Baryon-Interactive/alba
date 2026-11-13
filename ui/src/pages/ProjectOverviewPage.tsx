import { Link } from 'react-router';
import type { ProjectOverview } from '@api';
import { Empty, ErrorBox, StageBadge } from '@/components/common';
import { ActionButtons } from '@/components/ActionDialog';
import { CapacitySummary } from '@/components/CapacitySummary';
import { ProducerOverviewCard } from '@/components/ProducerActivity';
import { NightlyGatesCard } from '@/components/NightlyGatesCard';
import { Button } from '@/components/ui/button';
import { commitAgeClass, statusColor } from '@/components/StatusPalette';
import { stepText } from '@/lib/monitoring';
import { Skeleton } from '@/components/ui/misc';
import { useProjectId, useProjectOverview } from '@/lib/queries';
import { ago, duration, tokens } from '@/lib/format';
import { stageLabel } from '@/lib/stages';
import { attentionLabel, orderPath, projectPath, STAGE_ORDER } from '@/lib/overview';
import { t } from '@/i18n';

const panel = 'rounded-xl border bg-card overflow-hidden';

function greeting(at: string): string {
  const hour = new Date(at).getHours();
  return hour < 5 ? t('Working through the night') : hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
}

/** The first thing a person sees: what needs them, what is moving, what landed. */
function Brief({ o }: { o: ProjectOverview }) {
  const base = projectPath(o.project);
  const merged = o.mergesPerDay.slice(-7).reduce((a, b) => a + b, 0);
  const tiles = [
    { label: t('Needs you'), value: o.needsCount, to: `${base}/needs`, color: 'var(--brand)', strong: o.needsCount > 0 },
    { label: t('Running'), value: o.live.count, to: `${base}/runs`, color: 'var(--info)' },
    { label: t('Waiting for review'), value: o.stages['awaiting-review'] ?? 0, to: `${base}/board?stage=awaiting-review`, color: 'var(--review)' },
    { label: t('Merged in 7 days'), value: merged, to: `${base}/board?stage=merged`, color: 'var(--success)' },
    { label: t('Tokens today'), value: tokens(o.usage?.today.total.tokens), to: `${base}/usage`, color: 'var(--muted-foreground)' },
  ];
  return <section className="relative overflow-hidden rounded-2xl border bg-card">
    <div aria-hidden className="pointer-events-none absolute -top-24 right-[-6rem] size-72 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--brand)_30%,transparent),transparent_65%)]" />
    <div className="relative px-6 pt-5 pb-1">
      <div className="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">{o.name}</div>
      <h1 className="mt-1 text-[26px] leading-tight font-semibold tracking-[-0.02em]">{greeting(o.at)}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{o.needsCount ? t('{n} things are waiting for you; everything else is moving on its own.', { n: o.needsCount }) : t('Nothing is waiting for you. The workers carry on.')} <span className="whitespace-nowrap">{t('{n} orders', { n: o.total })} · {t('read {when}', { when: ago(o.at) })}</span></p>
    </div>
    <div className="relative grid grid-cols-2 gap-px p-4 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map(tile => <Link key={tile.label} to={tile.to} className="group rounded-xl px-3 py-2.5 transition-colors hover:bg-accent/60">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden className="size-1.5 rounded-full" style={{ background: tile.color }} />{tile.label}</div>
        <div className={`mt-1 text-[28px] leading-none font-semibold tabular-nums tracking-[-0.02em] ${tile.strong ? 'text-primary' : ''}`}>{tile.value}</div>
      </Link>)}
    </div>
  </section>;
}

function Attention({ o }: { o: ProjectOverview }) {
  const base = projectPath(o.project);
  const picks = o.pendingPicks?.items ?? [];
  const quotes = o.pendingQuotes.items;
  const problems = o.attention.filter(g => g.problem || g.kind === 'blocked');
  const actionable = o.needsYou.items.filter(item => item.stage === 'awaiting-review' || item.stage === 'awaiting-user');
  const cards = o.next.moves.filter(item => item.mode === 'card');
  const count = o.needsYou.items.length + picks.length + quotes.length + cards.length;
  return <section className={`${panel} ${count ? 'border-brand/45' : ''}`}>
    <div className={`flex items-center justify-between border-b px-5 py-3 ${count ? 'bg-brand/8' : ''}`}><h2 className="flex items-center gap-2 text-[13px] font-semibold">{t('Needs you')} {count > 0 && <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] text-brand-foreground tabular-nums">{count}</span>}</h2><Link className="text-xs text-muted-foreground hover:underline" to={`${base}/needs`}>{t('View all')}</Link></div>
    {!count && <div className="px-4"><Empty>{t('Nothing is waiting for you.')}</Empty></div>}
    <div className="max-h-72 overflow-y-auto divide-y">
      {actionable.map(item => <div key={item.tag} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <StageBadge stage={item.stage} waitingFor={item.waitingFor} />
        <Link to={orderPath(o.project, item.tag)} className="min-w-52 flex-1 text-sm hover:underline"><span className="mr-2 font-mono text-xs text-muted-foreground">{item.tag}</span>{item.title}{item.report?.question && <span className="ml-2 text-xs text-muted-foreground">{item.report.question}</span>}</Link>
        <div className="flex flex-wrap items-center gap-2">
          {item.stage === 'awaiting-review' ? <><Button asChild size="sm" variant="ghost"><Link to={`${orderPath(o.project, item.tag)}?tab=review`}>{t('Review the diff')}</Link></Button><ActionButtons project={o.project} tag={item.tag} actions={item.actions} only={item.actions.filter(a => a === 'approve' || a === 'rework')} noBranch={!item.branch} /></> : item.stage === 'awaiting-user' && item.waitingFor !== 'card' ? <ActionButtons project={o.project} tag={item.tag} actions={item.actions} only={['answer']} context={item.report?.question} /> : <Button asChild size="sm" variant="outline"><Link to={orderPath(o.project, item.tag)}>{item.waitingFor === 'card' ? t('Open order') : t('Look at the problem')}</Link></Button>}
        </div>
      </div>)}
      {picks.map(p => <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2"><span className="text-xs text-warning">{t('Waiting for a pick')}</span><span className="flex-1 text-sm">{p.title}</span><Button asChild size="sm" variant="outline"><Link to={`${base}/picks#${encodeURIComponent(p.id)}`}>{t('Look and choose')}</Link></Button></div>)}
      {quotes.map(q => <div key={`${q.tag}:${q.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2"><span className="text-xs text-warning">{t('Quotes waiting for approval')}</span><span className="flex-1 text-sm">{q.tag} · {q.service}</span><Button asChild size="sm" variant="outline"><Link to={`${base}/needs#quotes`}>{t('Review spend')}</Link></Button></div>)}
      {cards.map(item => <div key={`card:${item.tag}`} className="flex flex-wrap items-center gap-3 px-4 py-2"><span className="text-xs text-warning">{t('Cards: start a session by hand')}</span><span className="flex-1 text-sm">{item.tag} · {item.worker}</span><Button asChild size="sm" variant="outline"><Link to={orderPath(o.project, item.tag)}>{t('Open order')}</Link></Button></div>)}
    </div>
    {problems.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">{problems.map(g => <Link key={g.kind} to={`${base}/needs`} className="text-destructive hover:underline">{attentionLabel(g.kind)} · {g.items.length}</Link>)}</div>}
  </section>;
}

function Live({ o }: { o: ProjectOverview }) {
  return <section className={panel}><div className="flex items-center justify-between border-b px-5 py-3"><h2 className="flex items-center gap-2 text-[13px] font-semibold">{o.live.items.length > 0 && <span aria-hidden className="live-dot size-1.5 rounded-full bg-info" />}{t('Live work')} <span className="rounded-full bg-info/15 px-2 py-0.5 text-[11px] text-info tabular-nums">{o.live.items.length}</span></h2><Link className="text-xs text-muted-foreground hover:underline" to={`${projectPath(o.project)}/runs`}>{t('All runs')}</Link></div>
    {!o.live.items.length && <div className="px-4"><Empty>{t('Nothing is running')}</Empty></div>}
    <div className="max-h-80 overflow-y-auto divide-y">{o.live.items.map(r => <Link key={r.tag} to={r.run ? `${orderPath(o.project, r.tag)}/runs/${encodeURIComponent(r.run.id)}` : orderPath(o.project, r.tag)} className={`block border-l-[3px] px-4 py-2 hover:bg-accent/30 ${(r.commitMinutes ?? 0) > 60 ? 'border-l-destructive bg-destructive/5' : (r.commitMinutes ?? 0) > 45 ? 'border-l-warning bg-warning/5' : 'border-l-info'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-mono text-xs text-info">{r.tag}</span><span className="min-w-52 flex-1 text-sm font-medium">{r.title}</span><span className="text-xs">{r.run?.worker ?? r.worker ?? '—'}</span><span className="text-xs text-muted-foreground">{t('Elapsed {time}', { time: duration(r.run?.started ?? r.monitor?.started ?? r.updated, o.at) })}</span></div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs"><span className="min-w-52 flex-1 text-muted-foreground">{stepText(r.progress)}{r.progress?.current ? ` · ${r.progress.current}` : t('No step reported')}</span><span className={`font-medium ${commitAgeClass(r.commitMinutes)}`}>{r.commitMinutes === undefined ? t('Commit time unknown') : t('{n} min without a commit', { n: r.commitMinutes })}</span><span className="tabular-nums text-muted-foreground">{tokens(r.spend?.total_tokens)} {t('tokens')}</span></div>
    </Link>)}</div>
  </section>;
}

function Stages({ o }: { o: ProjectOverview }) {
  const total = Math.max(1, o.total);
  return <section className={panel}><h2 className="border-b px-4 py-3 text-sm font-semibold">{t('Stages')}</h2><div className="space-y-2 p-4">{STAGE_ORDER.filter(s => o.stages[s]).map(s => <Link key={s} to={`${projectPath(o.project)}/board?stage=${s}`} className="flex items-center gap-2 text-xs"><span className="w-24 truncate">{stageLabel(s)}</span><span className="h-2 flex-1 overflow-hidden rounded bg-muted"><span className="block h-full rounded" style={{ width: `${100 * (o.stages[s] ?? 0) / total}%`, background: statusColor(s) }} /></span><span className="w-7 text-right tabular-nums">{o.stages[s]}</span></Link>)}</div></section>;
}

function NextUp({ o }: { o: ProjectOverview }) {
  if (!o.nextUp.length) return null;
  return <section className={panel}><h2 className="border-b px-4 py-3 text-sm font-semibold">{t('Next up')}</h2><div className="max-h-64 overflow-auto px-4">{o.nextUp.map(n => <Link key={n.tag} to={`${projectPath(o.project)}/orders/${encodeURIComponent(n.tag)}`} className="block border-b py-2 last:border-0"><div className="flex gap-2"><span className="font-mono text-xs text-primary">{n.tag}</span><span className="truncate text-sm">{n.title}</span></div><div className="mt-1 text-xs text-muted-foreground">{n.reason}{n.worker ? ` · ${n.worker}` : ''}</div></Link>)}</div></section>;
}

function Dependencies({ o }: { o: ProjectOverview }) {
  if (!o.dependencies.length) return null;
  return <section className={panel}><h2 className="border-b px-4 py-3 text-sm font-semibold">{t('Dependencies')}</h2><div className="max-h-64 overflow-auto px-4">{o.dependencies.map(d => <div key={d.tag} className="border-b py-2 last:border-0"><div className="flex gap-2 text-sm"><Link className="font-mono text-primary" to={orderPath(o.project, d.tag)}>{d.tag}</Link><span className="truncate">{d.title}</span><span className="ml-auto text-xs tabular-nums">{d.count}</span></div>{d.items.slice(0, 3).map(i => <Link key={i.tag} className="mt-1 block pl-4 text-xs text-muted-foreground" to={orderPath(o.project, i.tag)}>{i.tag} · {i.title}</Link>)}</div>)}</div></section>;
}

export function ProjectOverviewPage() {
  const project = useProjectId(); const q = useProjectOverview(project);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-32" /><Skeleton className="h-64" /></div>;
  const o = q.data;
  return <div className="space-y-4"><Brief o={o} />
    <Attention o={o} /><NightlyGatesCard gates={o.nightlyGates} project={project} /><ProducerOverviewCard project={project} /><Live o={o} /><CapacitySummary project={project} workers={o.workers.items} capacity={o.capacity} />
    <details className={`${panel} text-sm`}><summary className="px-4 py-3 font-medium">{t('Planning, drafts and dependencies')} <span className="ml-2 text-xs text-muted-foreground">{t('{n} drafts or held', { n: (o.stages.draft ?? 0) + (o.stages.held ?? 0) })}</span></summary><div className="grid gap-3 border-t p-3 lg:grid-cols-3"><Stages o={o} /><NextUp o={o} /><Dependencies o={o} /></div></details>
  </div>;
}
