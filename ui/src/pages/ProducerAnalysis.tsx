import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AcceptanceCard } from '@/components/AcceptanceCard';
import { Factory, Check, CircleAlert, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { ProducerAction, ProducerCase, ProducerSession } from '@api';
import { toast } from 'sonner';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { ProducerConversation } from '@/components/ProducerConversation';
import { FlowFacts, RoutingFacts } from '@/components/ProducerFacts';
import { ProducerConstraints } from '@/components/ProducerConstraints';
import { ProducerTrust, ProducerBriefHistory } from '@/components/ProducerTrustBriefs';
import { ProducerRoundFacts, CleanPlanItems } from '@/components/ProducerRoundFacts';
import { ProducerGoalFacts } from '@/components/ProducerGoalFacts';
import { Skeleton } from '@/components/ui/misc';
import { useProducer, useProducerAnalysis, useProducerInsights, useProducerAction, useProducerPause, useProjectId } from '@/lib/queries';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';

function modeTone(mode: string): Tone {
  return mode === 'auto' ? 'danger' : mode === 'propose' ? 'primary' : mode === 'observe' ? 'warning' : 'neutral';
}

function gateItems(value: unknown): { name: string; status: string; reason?: string }[] {
  if (!value || typeof value !== 'object') return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { name?: unknown; status?: unknown; reason?: unknown; ok?: unknown };
    const status = row.status === 'pass' || row.status === 'ok' || row.ok === true ? 'pass' : String(row.status ?? 'warn');
    return [{ name: String(row.name ?? `gate-${index + 1}`), status, ...(row.reason ? { reason: String(row.reason) } : {}) }];
  });
}

function gateTone(status: string): Tone {
  return status === 'pass' || status === 'ok' ? 'success' : status === 'fail' ? 'danger' : 'warning';
}

function pointerLink(project: string, pointer: string) {
  const [kind, ...rest] = pointer.split(':');
  const value = rest.join(':') || pointer;
  const base = `/p/${encodeURIComponent(project)}`;
  const to = kind === 'order' && value ? `${base}/orders/${encodeURIComponent(value)}`
    : kind === 'design' ? `${base}/design/${encodeURIComponent(value.split('-')[0])}?tab=${value.includes('-G') ? 'gap' : 'target'}#${encodeURIComponent(value)}`
    : `${base}/producer#${encodeURIComponent(pointer)}`;
  return <Link key={pointer} className="text-primary hover:underline" to={to}>{pointer}</Link>;
}

function CaseCard({ project, c }: { project: string; c: ProducerCase }) {
  const gates = gateItems(c.card.gates);
  return (
    <Card className="p-4" id={c.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={c.status === 'open' ? 'primary' : 'neutral'}>{t(c.trigger)}</Badge>
          {c.order && <TagLink project={project} tag={c.order} />}
          {c.card.stage && <Badge tone="outline">{c.card.stage}</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">{ago(c.updatedAt)}</span>
      </div>
      {gates.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{gates.map(g => <Badge key={g.name} tone={gateTone(g.status)} title={g.reason}>{g.name}: {g.status}</Badge>)}</div>}
      <p className="mt-3 whitespace-pre-wrap text-sm">{c.card.summary}</p>
      <ProducerGoalFacts facts={c.facts} />
      {c.trigger === 'dispatch' && Array.isArray(c.facts.next) && <div className="mt-2 text-xs">{(c.facts.next as { tag: string; why: string }[]).map(n => <p key={n.tag}>{n.tag}: {n.why}</p>)}</div>}
      {c.trigger === 'clean' && !!c.facts.plan && <CleanPlanItems plan={c.facts.plan as import('@api').CleanPlan} />}
      {c.card.acceptance && <div className="mt-3"><AcceptanceCard project={project} card={c.card.acceptance} /></div>}
      {c.card.untrusted.length > 0 && <div className="mt-2 flex items-center gap-1.5 text-xs text-warning"><CircleAlert className="size-3.5" />{t('Contains untrusted text')}: {c.card.untrusted.join(', ')}</div>}
      {c.card.pointers.length > 0 && <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">{c.card.pointers.map(p => pointerLink(project, p))}</div>}
    </Card>
  );
}

function ActionMeta({ project, a }: { project: string; a: ProducerAction }) {
  return <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><Link className="font-mono text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/producer#${encodeURIComponent(a.caseId)}`}>{a.caseId}</Link>{a.reviewCard && <Link className="text-primary hover:underline" to={a.reviewCard}>{t('Acceptance review')}</Link>}<span>{a.kind}</span><span>{t('rule')}: {a.ruleId}</span><span>{t('source')}: {a.mode}</span><span title={dateTime(a.at)}>{ago(a.at)}</span></div>;
}

function ActionCard({ project, a, children }: { project: string; a: ProducerAction; children?: ReactNode }) {
  return <Card className="p-3.5"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={a.status === 'proposed' ? 'primary' : a.status === 'done' ? 'success' : a.status === 'failed' ? 'danger' : 'outline'}>{a.kind}</Badge>{a.note && <span className="font-medium">{a.note}</span>}</div><ActionMeta project={project} a={a} /></div>{children}</div>{a.reason && <p className="mt-2 text-sm text-muted-foreground">{t('Reason')}: {a.reason}</p>}{a.cleanPlan && <CleanPlanItems plan={a.cleanPlan} />}{a.result && <p className="mt-1 text-xs text-success">{a.result}</p>}{a.refusal && <p className="mt-1 text-xs text-destructive">{a.refusal}</p>}</Card>;
}

function SessionPanel({ session, budget }: { session: ProducerSession; budget?: number }) {
  const used = session.usage?.total_tokens;
  return <><Section title={t('Producer session')}><Card className="p-4"><div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3"><div><span className="text-muted-foreground">{t('State')}: </span>{t(session.state)}</div><div><span className="text-muted-foreground">{t('Model')}: </span>{session.model ?? '—'}</div><div><span className="text-muted-foreground">{t('Turns')}: </span>{session.turnCount ?? '—'}</div><div><span className="text-muted-foreground">{t('Usage')}: </span>{used !== undefined ? `${used}${budget !== undefined ? ` / ${budget}` : ''}` : '—'}</div><div><span className="text-muted-foreground">{t('Last heartbeat')}: </span>{session.lastHeartbeat ? ago(session.lastHeartbeat) : '—'}</div><div><span className="text-muted-foreground">{t('Session wanted')}: </span>{session.wanted ? t('yes') : t('no')}</div><div><span className="text-muted-foreground">{t('Last automatic restart')}: </span>{session.lastRestartedAt ? ago(session.lastRestartedAt) : t('Not recorded')}</div>{session.lastError && <div className="text-destructive"><span className="text-muted-foreground">{t('Last error')}: </span>{session.lastError}</div>}</div></Card></Section>
    <ProducerConversation turns={Array.isArray(session.turns) ? session.turns : []} /></>;
}

function OrderEvents() {
  const routeProject = useProjectId();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const project = routeProject || params.get('project') || '';
  const q = useProducer(project);
  const pause = useProducerPause(project);
  const run = useProducerAction(project);
  const [showClosed, setShowClosed] = useState(!!hash);
  useEffect(() => { if (hash) setShowClosed(true); }, [hash]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const d = q.data;
  const openCases = useMemo(() => d?.cases.filter(c => c.status === 'open') ?? [], [d]);
  const closedCases = useMemo(() => d?.cases.filter(c => c.status === 'closed') ?? [], [d]);
  const proposed = useMemo(() => (d?.actions ?? []).filter(a => a.status === 'proposed' && !dismissed.has(a.id)), [d, dismissed]);
  if (!project) return <ErrorBox error={new Error(t('Choose a project to open the Producer page.'))} />;
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!d) return <div className="grid gap-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;
  const doRun = async (a: ProducerAction) => { try { await run.mutateAsync({ actionId: a.id }); toast.success(t('Producer action completed')); } catch { /* query error is shown by the mutation state */ } };
  const togglePause = () => { void pause.mutateAsync(!d.paused).then(() => toast.success(d.paused ? t('Producer resumed') : t('Producer paused'))).catch(() => undefined); };
  return (
    <div>
      <PageHeader title={<><Factory className="size-5" />{t('Producer')}</>}>
        <span className="flex flex-wrap items-center gap-2"><Badge tone={d.enabled ? 'success' : 'neutral'}>{d.enabled ? t('enabled') : t('disabled')}</Badge><Badge tone={d.paused ? 'warning' : 'primary'}>{d.paused ? t('paused') : t('running')}</Badge><span>{t('Policy')} {d.policy.version}</span></span>
      </PageHeader>
      <div className="mb-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="p-4"><div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('Rules')}</h2><Button size="sm" variant={d.paused ? 'success' : 'destructive'} onClick={togglePause} disabled={pause.isPending}>{d.paused ? <Play /> : <Pause />}{d.paused ? t('Resume') : t('Pause')}</Button></div><div className="grid gap-2">{d.policy.rules.length ? d.policy.rules.map(rule => <div key={rule.id} className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={modeTone(rule.mode)}>{rule.mode}</Badge><span className="font-medium">{rule.action}</span><span className="text-muted-foreground">{rule.id}</span><span className="basis-full text-xs text-muted-foreground sm:basis-auto">{rule.instruction}</span></div>) : <span className="text-sm text-muted-foreground">{t('No rules configured.')}</span>}</div></Card>
        <Card className="p-4 text-sm"><div className="text-muted-foreground">{t('Policy version')}</div><div className="mt-1 font-mono text-xs break-all">{d.policy.version}</div><div className="mt-3 text-muted-foreground">{t('Budgets')}</div><div className="mt-1 grid gap-1">{Object.entries(d.policy.budgets).length ? Object.entries(d.policy.budgets).map(([key, value]) => <div key={key} className="flex justify-between gap-2"><span>{key}</span><span className="tabular-nums">{value}</span></div>) : <span>—</span>}</div></Card>
      </div>
      {d.session && <SessionPanel session={d.session} budget={d.policy.budgets.usage_per_day} />}
      <Section title={t('Open cases')} count={openCases.length}>
        {openCases.length ? <div className="grid gap-3">{openCases.map(c => <CaseCard key={c.id} project={project} c={c} />)}</div> : <Empty>{t('No open producer cases.')}</Empty>}
      </Section>
      <Section title={t('Would do')} count={d.wouldDo.length}>
        {d.wouldDo.length ? <div className="grid gap-2">{d.wouldDo.slice(0, 50).map(a => <ActionCard key={a.id} project={project} a={a} />)}</div> : <Empty>{t('No observe actions yet.')}</Empty>}
      </Section>
      <Section title={t('Waiting for a click')} count={proposed.length}>
        {proposed.length ? <div className="grid gap-2">{proposed.map(a => <ActionCard key={a.id} project={project} a={a}><div className="flex items-center gap-1"><Button size="sm" onClick={() => void doRun(a)} disabled={run.isPending}><Check />{t('Run')}</Button><Button size="sm" variant="ghost" onClick={() => setDismissed(old => new Set(old).add(a.id))}><X />{t('Dismiss')}</Button></div></ActionCard>)}</div> : <Empty>{t('No proposed actions.')}</Empty>}
      </Section>
      {closedCases.length > 0 && <Section title={t('Closed cases')} count={closedCases.length} actions={<Button size="sm" variant="outline" onClick={() => setShowClosed(v => !v)}>{showClosed ? t('Hide closed') : t('Show closed')}</Button>}>{showClosed && <div className="grid gap-3">{closedCases.map(c => <CaseCard key={c.id} project={project} c={c} />)}</div>}</Section>}
      {run.isError && <div className="mt-3"><ErrorBox error={run.error} /></div>}
      {pause.isError && <div className="mt-3"><ErrorBox error={pause.error} /></div>}
      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><RotateCcw className="size-3" />{t('Refreshes every 30 seconds')}</div>
    </div>
  );
}

export function ProducerAnalysis({ project }: { project: string }) {
  const { hash } = useLocation();
  const q = useProducerAnalysis(project);
  const insights = useProducerInsights(project);
  const producer = useProducer(project);
  const goals = producer.data?.cases.filter(c => c.status === 'open' && ['target-failing', 'target-unmeasured', 'gap-unowned', 'idle-capacity'].includes(c.trigger)) ?? [];
  const [eventsOpen, setEventsOpen] = useState(!!hash);
  useEffect(() => { if (hash) setEventsOpen(true); }, [hash]);
  return <div className="min-h-0 flex-1 overflow-y-auto pr-2" role="tabpanel" id="producer-analysis">
    {q.data && <ProducerRoundFacts project={project} data={q.data} />}
    <ProducerConstraints snapshot={q.data?.snapshot ?? null} />
    <Section title={t('Goal')} count={goals.length}>{producer.isError ? <ErrorBox error={producer.error} /> : goals.length ? <div className="grid gap-3">{goals.map(c => <CaseCard key={c.id} project={project} c={c} />)}</div> : <Card className="p-4 text-sm text-muted-foreground">{t('No open milestone goals.')}</Card>}</Section>
    {q.isError ? <ErrorBox error={q.error} /> : !q.data ? <Skeleton className="mb-6 h-48" /> : <FlowFacts snapshot={q.data.snapshot} project={project} />}
    {insights.isError ? <ErrorBox error={insights.error} /> : <ProducerTrust project={project} trust={insights.data?.trust ?? []} />}
    <RoutingFacts snapshot={q.data?.snapshot ?? null} />
    <ProducerBriefHistory briefs={insights.data?.briefs ?? []} />
    <details className="mb-6 rounded-lg border border-border p-4" open={eventsOpen} onToggle={e => setEventsOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold">{t('Order events')}</summary>{eventsOpen && <div className="mt-4"><OrderEvents /></div>}</details>
  </div>;
}
