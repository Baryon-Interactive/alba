import { DraftPanel } from '@/components/DraftPanel';
import { AcceptanceCard } from '@/components/AcceptanceCard';
import { OrderAccounting } from '@/components/Usage';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { ArrowRight, CircleDot, FileText, Play } from 'lucide-react';
import { ORDER_ACTIONS, type OrderDetail, type OrderEvent, type OrderSummary, type Run } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ActionButtons, ActionDialog } from '@/components/ActionDialog';
import { CheckPanel } from '@/components/CheckPanel';
import { EvidencePanel } from '@/components/EvidencePanel';
import { LessonsSection, QuestionsSection, ReferencedDecisions, SpendSection } from '@/components/OrderExtras';
import { MessageBox } from '@/components/MessageBox';
import { MonitorPanel, ProgressPanel, RotationNote } from '@/components/Monitoring';
import { MergeReadinessSection } from '@/components/MergeReadinessSection';
import { OrderSkillsPanel, RoutePanel, RunRoutingNote } from '@/components/RoutingPanels';
import { Empty, ErrorBox, Section, StageBadge, TagLink, UsageText } from '@/components/common';
import { draftKey, hasDraft } from '@/lib/drafts';
import { useOrder, useOrders, useProjectId, useRoute } from '@/lib/queries';
import { stageLabel, visibleActions, waitingFor } from '@/lib/stages';
import { ago, dateTime, duration } from '@/lib/format';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { statusColor } from '@/components/StatusPalette';

const ReviewPanel = lazy(() => import('@/components/ReviewPanel'));

const TABS = ['overview', 'runs', 'timeline', 'check', 'evidence', 'review'] as const;

interface Blocker { tag: string; stage?: OrderSummary['stage']; title?: string; holds: Blocker[] }

/** The chain of orders that hold this one: every need that is not merged, and what holds it in turn. */
function useBlockers(project: string, order: OrderDetail) {
  const list = useOrders(project);
  return useMemo(() => {
    const byTag = new Map((list.data?.items ?? []).map(o => [o.tag, o]));
    const walk = (tag: string, seen: Set<string>): Blocker => {
      const o = byTag.get(tag);
      const holds = !o || seen.has(tag) ? [] : o.needs.filter(n => byTag.get(n)?.stage !== 'merged').map(n => walk(n, new Set([...seen, tag])));
      return { tag, stage: o?.stage, title: o?.title, holds };
    };
    return order.needsStatus.filter(n => n.stage !== 'merged').map(n => walk(n.tag, new Set([order.order.tag])));
  }, [list.data, order]);
}

function BlockerRow({ project, b, depth = 0 }: { project: string; b: Blocker; depth?: number }) {
  return (
    <>
      <div className="flex items-center gap-2 py-1 text-sm" style={{ paddingLeft: depth * 20 }}>
        {depth > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
        <TagLink project={project} tag={b.tag} />
        {b.title && <span className="min-w-0 truncate text-muted-foreground">{b.title}</span>}
        {b.stage ? <StageBadge stage={b.stage} /> : <Badge tone="danger">{t('unknown')}</Badge>}
        {b.stage && <span className="text-xs text-muted-foreground">{waitingFor(b.stage)}</span>}
      </div>
      {b.holds.map(h => <BlockerRow key={h.tag} project={project} b={h} depth={depth + 1} />)}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === '') return null;
  return (
    <div className="flex gap-3 py-1 text-sm"><dt className="w-28 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>
  );
}

const STATUS_TONE = { progress: 'neutral', monitoring: 'primary', waiting: 'primary', ready: 'success', blocked: 'danger', failed: 'danger', dropped: 'danger' } as const;

function Overview({ project, d }: { project: string; d: OrderDetail }) {
  const blockers = useBlockers(project, d);
  const o = d.order;
  const route = useRoute(project, o.tag);
  const m = o.mandate;
  const reroute = d.reroutes?.at(-1);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid content-start gap-6">
        {reroute && <Section title={t('Worker change')}><Card className="p-4" data-testid="worker-reroute">
          <p className="text-sm font-semibold">{t('from {from} to {to}', { from: reroute.from, to: reroute.to })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{dateTime(reroute.at)}{o.nextWorker && <> · {t('Next worker')}: {o.nextWorker}</>}</p>
          <p className="mt-3 whitespace-pre-wrap text-sm">{reroute.note}</p>
          <h3 className="mt-4 text-sm font-semibold">{t('Handoff brief')}</h3>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">{reroute.brief}</pre>
        </Card></Section>}
        {d.acceptance && <AcceptanceCard project={project} card={d.acceptance} canApprove={d.stage === 'awaiting-review'} />}
        {o.intent && <DraftPanel project={project} order={o} />}
        {d.monitor && <MonitorPanel m={d.monitor} />}
        {d.progress && <ProgressPanel p={d.progress} />}
        <MessageBox project={project} tag={o.tag} d={d} />
        {d.producerNotes && <Section title="Producer notes"><Card className="p-4 text-sm"><h3 className="font-semibold">Project</h3><p className="whitespace-pre-wrap">{d.producerNotes.project || 'No project notes.'}</p><h3 className="mt-3 font-semibold">{o.tag}</h3><p className="whitespace-pre-wrap">{d.producerNotes.order || 'No order notes.'}</p></Card></Section>}
        {blockers.length > 0 && (
          <Section title={t('Held back by')} count={blockers.length}>
            <Card><CardContent>{blockers.map(b => <BlockerRow key={b.tag} project={project} b={b} />)}</CardContent></Card>
          </Section>
        )}
        <QuestionsSection project={project} d={d} />
        <ReferencedDecisions d={d} />
        <RoutePanel project={project} tag={o.tag} />
        <OrderSkillsPanel project={project} tag={o.tag} />
        {d.deliveryLint?.lint && <Section title={t('Delivery lint')}>
          <Card className="p-3.5">
            <p className="text-xs text-muted-foreground">{dateTime(d.deliveryLint.at)} · {t('Report')} #{d.deliveryLint.report}</p>
            <ul className="mt-2 grid gap-2 text-sm">{d.deliveryLint.lint.map((i, n) => <li key={n}><Badge tone={i.ok ? 'success' : 'danger'}>{i.ok ? 'PASS' : 'FAIL'}</Badge> <span className="font-medium">{i.name}</span>{i.detail && <p className="mt-1 text-muted-foreground">{i.detail}</p>}</li>)}</ul>
          </Card>
        </Section>}
        <Section title={t('Reports')} count={d.reports.length}>
          {d.reports.length === 0 ? <Empty>{t('No reports yet.')}</Empty> : (
            <div className="grid gap-2">
              {[...d.reports].reverse().map(r => (
                <Card key={r.seq} className="p-3.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    <span>{dateTime(r.at)}</span>{r.run && <span>{r.run}</span>}{r.from && <span>{r.from}</span>}
                    {r.source && <Badge tone="outline">{t('inferred')}</Badge>}
                  </div>
                  <p className="mt-1.5 text-sm">{r.summary}</p>
                  {r.question && <p className="mt-1.5 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-1.5 text-sm">{r.question}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    {r.commits.length > 0 && <span>{t('commits')}: <span className="font-mono">{r.commits.join(', ')}</span></span>}
                    {r.evidence.length > 0 && <span>{t('evidence')}: {r.evidence.join(', ')}</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Section>
        {d.file && (
          <Section title={<><FileText className="size-4" />{t('Work order')}</>} actions={<span className="font-mono text-xs text-muted-foreground">{d.file.path}</span>}>
            <Card><pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{d.file.markdown}{d.file.truncated ? `\n\n… ${t('cut')}` : ''}</pre></Card>
          </Section>
        )}
      </div>

      <div className="grid content-start gap-6">
        <Section title={t('Why this stage')}>
          <Card className="p-3.5 text-sm">
            <div className="flex items-center gap-2"><StageBadge stage={d.stage} waitingFor={d.waitingFor} /><span className="text-muted-foreground">{waitingFor(d.stage, d.waitingFor)}</span></div>
            <p className="mt-2">{d.why}</p>
          </Card>
        </Section>
        <Section title={t('Definition')}>
          <Card><CardContent><dl>
            <Fact label={t('Role')}>{route.data?.role?.id ?? o.role}</Fact>
            <Fact label={t('Worker')}>{route.data?.chosen ?? o.worker}</Fact>
            <Fact label={t('Next worker')}>{o.nextWorker}</Fact>
            <Fact label={t('Kind')}>{o.kind}</Fact>
            <Fact label={t('Heavy class')}>{o.heavy}</Fact>
            <Fact label={t('Uses')}>{o.uses?.length ? o.uses.map(u => <Badge key={u} tone="outline" className="mr-1.5">{u}</Badge>) : undefined}</Fact>
            <Fact label={t('Needs')}>{o.needs.length ? o.needs.map(n => <span key={n} className="mr-2"><TagLink project={project} tag={n} /></span>) : undefined}</Fact>
            <Fact label={t('Condition')}>{o.condition}</Fact>
            <Fact label={t('Branch')}><span className="font-mono text-xs">{o.branch}</span></Fact>
            <Fact label={t('Base')}><span className="font-mono text-xs">{o.base_ref}</span></Fact>
            <Fact label={t('Worktree')}><span className="font-mono text-xs">{d.worktree ?? o.worktree}</span></Fact>
            <Fact label={t('Created')}>{dateTime(o.created)}</Fact>
            <Fact label={t('Updated')}>{dateTime(o.updated)}</Fact>
            <Fact label={t('Calls by other tools')}>{d.externalCalls?.length ? d.externalCalls.map(c => <div key={c.ledger} className="text-xs"><span className="font-mono">{c.ledger}</span>: {t('{ok} succeeded, {failed} failed', { ok: c.ok, failed: c.failed })}</div>) : undefined}</Fact>
          </dl></CardContent></Card>
        </Section>
        {m && (
          <Section title={t('Mandate')}>
            <Card><CardContent><dl>
              <Fact label={t('Quote')}><span className="italic">{m.quote}</span></Fact>
              <Fact label={t('Decisions')}>{m.decisions}</Fact>
              <Fact label={t('Spend cap')}>{m.spend_cap !== undefined ? `$${m.spend_cap}` : undefined}</Fact>
              <Fact label={t('Protected paths')}>{m.protected_paths?.map(p => <div key={p} className="font-mono text-xs">{p}</div>)}</Fact>
            </dl></CardContent></Card>
          </Section>
        )}
        <OrderAccounting data={d.accounting} />
        <SpendSection project={project} d={d} />
        <LessonsSection d={d} />
      </div>
    </div>
  );
}

function RunRow({ project, tag, r }: { project: string; tag: string; r: Run }) {
  const open = !r.ended;
  return (
    <>
    <tr className="hover:bg-accent/40">
      <td className="px-4 py-2 font-mono text-[13px] font-semibold">
        {r.hasLog ? <Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(tag)}/runs/${encodeURIComponent(r.id)}`}>{r.id}</Link> : r.id}
      </td>
      <td className="px-2 py-2">{r.worker}</td>
      <td className="px-2 py-2 text-muted-foreground">{dateTime(r.started)}</td>
      <td className="px-2 py-2 tabular-nums">{duration(r.started, r.ended)}</td>
      <td className="px-2 py-2">
        {open ? <Badge tone="primary"><Play />{t('running')}</Badge> : <Badge tone={r.outcome === 'completed' ? 'success' : r.outcome === 'cancelled' ? 'neutral' : 'danger'}>{r.limit === 'unreachable' ? t('endpoint unreachable') : r.outcome}</Badge>}
        {r.imported && <Badge tone="outline" className="ml-1">{t('imported')}</Badge>}
      </td>
      <td className="px-2 py-2 text-xs"><UsageText usage={r.usage} /></td>
      <td className="max-w-64 truncate px-4 py-2 text-xs text-muted-foreground" title={r.note}>{r.note}</td>
    </tr>
    {(r.rotatedFrom || r.limit) && <tr><td colSpan={7} className="px-4 pb-2"><RotationNote r={r} /></td></tr>}
    {(r.routing || r.skills?.length) && <tr><td colSpan={7} className="px-4 pb-2"><RunRoutingNote r={r} /></td></tr>}
    </>
  );
}

function Timeline({ d }: { d: OrderDetail }) {
  const rows: OrderEvent[] = [...d.events].reverse();
  return (
    <div>
      {d.eventsTotal > d.events.length && <div className="mb-2 text-xs text-muted-foreground">{t('The newest {n} of {total} events', { n: d.events.length, total: d.eventsTotal })}</div>}
      <ol className="relative ml-2 border-l">
        {rows.map(e => (
          <li key={e.id} className="relative pb-3 pl-5">
            <CircleDot className="absolute top-0.5 -left-[7px] size-3.5 bg-background text-muted-foreground" />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{e.type}</span>
              {e.by && <Badge tone={e.by === 'web' ? 'primary' : 'outline'}>by {e.by}</Badge>}
              <span className="text-xs text-muted-foreground" title={dateTime(e.at)}>{ago(e.at)} · {dateTime(e.at)}</span>
            </div>
            {e.data && Object.keys(e.data).length > 0 && <div className="mt-0.5 font-mono text-xs break-words text-muted-foreground">{Object.entries(e.data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function OrderPage() {
  const project = useProjectId();
  const { tag = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useOrder(project, tag);
  const { hash } = useLocation();
  useEffect(() => {
    if (!q.data || !hash) return;
    let id: string;
    try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [q.data, hash]);
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? params.get('tab')! : 'overview';

  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-80" /><Skeleton className="h-48" /></div>;
  const d = q.data;
  // `?do=<action>` (from the command palette) opens the confirmation of that action.
  const wanted = ORDER_ACTIONS.find(a => a === params.get('do'));
  const closeAsk = () => setParams(p => { const n = new URLSearchParams(p); n.delete('do'); return n; }, { replace: true });
  const hasDiff = !!d.order.branch || !!d.worktree || d.stage === 'awaiting-review';

  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground"><Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/board`}>{t('Board')}</Link> / {d.order.tag}</div>
      <div className="relative mb-5 flex flex-wrap items-start justify-between gap-3 overflow-hidden rounded-2xl border bg-card px-5 pt-5 pb-4 before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-[var(--stage)]" style={{ '--stage': statusColor(d.stage) } as React.CSSProperties}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[13px] font-semibold text-muted-foreground">{d.order.tag}</span><StageBadge stage={d.stage} waitingFor={d.waitingFor} />{d.order.review === 'manual' && <Badge tone="warning">{t('Manual review')}</Badge>}</div>
          <h1 className="mt-1.5 text-[24px] leading-tight font-semibold tracking-[-0.02em]">{d.order.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{stageLabel(d.stage, d.waitingFor)} — {d.why}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButtons project={project} tag={tag} actions={d.actions} unavailable={d.unavailable} only={visibleActions(d.stage, d.actions).filter(a => a !== 'answer')} noBranch={!d.order.branch} />
          {d.actions.includes('answer') && <ActionButtons project={project} tag={tag} actions={d.actions} only={['answer']} context={[...d.reports].reverse().find(r => r.question)?.question} />}
          {d.order.kind === 'intake' && <Button asChild size="sm" variant="outline"><Link to={`/p/${encodeURIComponent(project)}/intake/${encodeURIComponent(tag)}`}>{t('Intake review')}</Link></Button>}
        </div>
      </div>

      {wanted && d.actions.includes(wanted) && (
        <ActionDialog project={project} tag={tag} action={wanted} open onOpenChange={o => !o && closeAsk()} context={wanted === 'answer' ? [...d.reports].reverse().find(r => r.question)?.question : undefined} noBranch={!d.order.branch} />
      )}
      {d.stage === 'awaiting-review' && <MergeReadinessSection project={project} tag={tag} enabled={!!d.order.branch} />}
      <Tabs value={tab} onValueChange={v => setParams(p => { const n = new URLSearchParams(p); n.set('tab', v); return n; }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="overview">{t('Overview')}</TabsTrigger>
          <TabsTrigger value="runs">{t('Runs')} <span className="text-xs text-muted-foreground">{d.runs.length}</span></TabsTrigger>
          <TabsTrigger value="timeline">{t('Timeline')} <span className="text-xs text-muted-foreground">{d.eventsTotal}</span></TabsTrigger>
          <TabsTrigger value="check">{t('Check')}{d.lastCheck && <span className={cn('size-1.5 rounded-full', d.lastCheck.ok ? 'bg-success' : 'bg-destructive')} />}</TabsTrigger>
          <TabsTrigger value="evidence">{t('Evidence')}</TabsTrigger>
          <TabsTrigger value="review">{t('Review')}{hasDraft(draftKey(project, tag)) && <Badge tone="warning">{t('Draft (unsent)')}</Badge>}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><Overview project={project} d={d} /></TabsContent>
        <TabsContent value="runs">
          {d.runs.length === 0 ? <Empty>{t('No runs yet.')}</Empty> : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">Run</th><th className="px-2 py-1.5 font-medium">{t('Worker')}</th><th className="px-2 py-1.5 font-medium">{t('Started')}</th><th className="px-2 py-1.5 font-medium">{t('Duration')}</th><th className="px-2 py-1.5 font-medium">{t('Outcome')}</th><th className="px-2 py-1.5 font-medium">{t('Usage')}</th><th className="px-4 py-1.5 font-medium">{t('Note it started with')}</th></tr></thead>
                <tbody className="divide-y">{[...d.runs].reverse().map(r => <RunRow key={r.id} project={project} tag={tag} r={r} />)}</tbody>
              </table>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="timeline"><Timeline d={d} /></TabsContent>
        <TabsContent value="check"><CheckPanel project={project} detail={d} /></TabsContent>
        <TabsContent value="evidence">{tab === 'evidence' && <EvidencePanel project={project} tag={tag} />}</TabsContent>
        <TabsContent value="review">
          {tab === 'review' && (hasDiff
            ? <Suspense fallback={<Skeleton className="h-64" />}><ReviewPanel project={project} detail={d} /></Suspense>
            : <Empty>{t('This order has no branch to review yet.')}</Empty>)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
