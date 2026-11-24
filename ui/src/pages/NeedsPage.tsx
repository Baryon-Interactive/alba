import { UnreadDot } from '@/components/OrderAttention';
import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleDollarSign, GitPullRequest, HelpCircle, Hand, Images, MousePointerClick, OctagonAlert, Send } from 'lucide-react';
import type { OrderAction, OrderSummary } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { ActionButtons, ActionDialog } from '@/components/ActionDialog';
import { OptionsPicker } from '@/components/OptionsPicker';
import { ReportEvidence } from '@/components/ReportEvidence';
import { QuoteCard } from '@/components/QuoteCard';
import { EmptyState, ErrorBox, PageHeader, Section, StageBadge, TagLink, UsageText, orderMeta } from '@/components/common';
import { visibleActions } from '@/lib/stages';
import { groupNeedsYou, type NeedsGroup } from '@/lib/needs';
import { useAct, useOverview, useProjectId } from '@/lib/queries';
import { ago } from '@/lib/format';
import { stepText } from '@/lib/monitoring';
import { t } from '@/i18n';

function Meta({ o }: { o: OrderSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {orderMeta(o).map(m => <Badge key={m} tone="outline">{m}</Badge>)}
      {o.report && <span>{ago(o.report.at)}</span>}
    </div>
  );
}

/** The question in words, with the answer box beside it: sending it opens the confirmation. */
function AnswerCard({ project, o }: { project: string; o: OrderSummary }) {
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [own, setOwn] = useState(false);
  const act = useAct(project);
  const options = o.report?.options ?? [];
  return (
    <Card className="border-warning/35 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <UnreadDot tag={o.tag} /><TagLink project={project} tag={o.tag} />
        <span className="font-medium">{o.title}</span>
        <StageBadge stage={o.stage} waitingFor={o.waitingFor} />
      </div>
      <Meta o={o} />
      {o.report?.summary && o.report.summary !== o.report.question && <p className="mt-2 text-sm text-muted-foreground">{o.report.summary}</p>}
      <blockquote className="mt-2 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-2 text-[14px] whitespace-pre-wrap">{o.report?.question ?? o.why}</blockquote>
      {options.length > 0 && (
        <OptionsPicker project={project} tag={o.tag} options={options} submit={(choice, note) => act.mutateAsync({ tag: o.tag, action: 'answer', choice, text: note || undefined })} />
      )}
      {(options.length === 0 || own) && (
        <div className="mt-3 flex items-end gap-2">
          <Textarea value={text} onChange={e => setText(e.target.value)} placeholder={t('Type your answer…')} className="min-h-14 flex-1" />
          <Button disabled={!text.trim()} onClick={() => setConfirm(true)}><Send />{t('Answer')}</Button>
        </div>
      )}
      {options.length > 0 && !own && <button className="mt-2 text-xs text-primary hover:underline" onClick={() => setOwn(true)}>{t('Answer in your own words instead')}</button>}
      {confirm && <ActionDialog project={project} tag={o.tag} action="answer" open onOpenChange={o2 => !o2 && setConfirm(false)} initialText={text} context={o.report?.question} />}
    </Card>
  );
}

/** An order that waits for a click on a card in a session of its own: nothing to type here, so no answer box. */
function CardWaitCard({ project, o }: { project: string; o: OrderSummary }) {
  return (
    <Card className="border-warning/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <UnreadDot tag={o.tag} /><TagLink project={project} tag={o.tag} />
          <span className="font-medium">{o.title}</span>
          <StageBadge stage={o.stage} waitingFor={o.waitingFor} />
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline"><Link to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(o.tag)}`}>{t('Open order')}</Link></Button>
          <ActionButtons project={project} tag={o.tag} actions={o.actions} only={visibleActions(o.stage, o.actions).filter(a => a === 'hold' || a === 'cancel')} />
        </div>
      </div>
      <Meta o={o} />
      {o.report?.summary && <p className="mt-2 text-sm">{o.report.summary}</p>}
      <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"><MousePointerClick className="mt-0.5 size-3.5 shrink-0" />{t('This order waits for a click on a card: start it in a session of your own. There is nothing to answer here.')}</p>
    </Card>
  );
}

function ReviewCard({ project, o }: { project: string; o: OrderSummary }) {
  return (
    <Card className="border-warning/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <UnreadDot tag={o.tag} /><TagLink project={project} tag={o.tag} />
          <span className="font-medium">{o.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost"><Link to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(o.tag)}?tab=review`}><GitPullRequest />{t('Review the diff')}</Link></Button>
          <ActionButtons project={project} tag={o.tag} actions={o.actions} only={visibleActions(o.stage, o.actions).filter(a => a === 'approve' || a === 'rework')} noBranch={!o.branch} />
        </div>
      </div>
      {o.report?.summary && <p className="mt-2 text-[15px] font-medium">{o.report.summary}</p>}
      <div className="mt-2"><Meta o={o} /></div>
      <ReportEvidence project={project} tag={o.tag} evidence={o.report?.evidence ?? []} commits={o.report?.commits ?? []} />
      {o.spend && <div className="mt-2 text-xs text-muted-foreground"><UsageText usage={o.spend} /></div>}
    </Card>
  );
}

function StuckRow({ project, o }: { project: string; o: OrderSummary }) {
  return (
    <Card className="flex flex-wrap items-start justify-between gap-3 p-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <UnreadDot tag={o.tag} /><TagLink project={project} tag={o.tag} />
          <span className="font-medium">{o.title}</span>
          <StageBadge stage={o.stage} waitingFor={o.waitingFor} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{o.report?.summary ?? o.why}</p>
        {o.report?.question && <p className="mt-1 rounded-md bg-muted px-2.5 py-1.5 text-sm">{o.report.question}</p>}
      </div>
      <div className="flex items-center gap-2"><ActionButtons project={project} tag={o.tag} actions={o.actions} only={(['answer', 'rework', 'queue', 'cancel'] as OrderAction[]).filter(a => o.actions.includes(a))} context={o.report?.question} /></div>
    </Card>
  );
}

function Group({ project, g }: { project: string; g: NeedsGroup }) {
  const base = `/p/${encodeURIComponent(project)}`;
  switch (g.id) {
    case 'answer':
      return <Section title={<><HelpCircle className="size-4 text-primary" />{t('Questions waiting for your answer')}</>} count={g.count}><div className="grid gap-3">{g.orders.map(o => <AnswerCard key={o.tag} project={project} o={o} />)}</div></Section>;
    case 'cardwait':
      return <Section title={<><MousePointerClick className="size-4 text-primary" />{t('Waiting for you to click a card')}</>} count={g.count}><div className="grid gap-3">{g.orders.map(o => <CardWaitCard key={o.tag} project={project} o={o} />)}</div></Section>;
    case 'quotes':
      return <Section title={<><CircleDollarSign className="size-4 text-primary" />{t('Quotes waiting for approval')}</>} count={g.count}><div className="grid gap-3">{g.quotes.map(q => <QuoteCard key={q.tag + q.id} project={project} quote={q} />)}</div></Section>;
    case 'picks':
      return (
        <Section title={<><Images className="size-4 text-primary" />{t('Waiting for a pick')}</>} count={g.count}>
          <div className="grid gap-2">
            {(g.picks ?? []).map(p => (
              <Card key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-mono text-[13px] font-semibold">{p.id}</span><span className="font-medium">{p.title}</span><UnreadDot tag={p.order} />{p.order && <TagLink project={project} tag={p.order} className="text-xs" />}<Badge tone="outline">{t('{n} options', { n: p.options })}</Badge></div>
                <Button asChild size="sm" variant="outline"><Link to={`${base}/picks#${encodeURIComponent(p.id)}`}>{t('Look and choose')}</Link></Button>
              </Card>
            ))}
          </div>
        </Section>
      );
    case 'review':
      return <Section title={<><CheckCircle2 className="size-4 text-primary" />{t('Waiting for your review')}</>} count={g.count}><div className="grid gap-3">{g.orders.map(o => <ReviewCard key={o.tag} project={project} o={o} />)}</div></Section>;
    case 'card':
      return (
        <Section title={<><Hand className="size-4 text-primary" />{t('Cards: start a session by hand')}</>} count={g.count}>
          <div className="grid gap-2">
            {g.cards.map(c => (
              <Card key={c.tag} className="flex items-center justify-between gap-3 p-3.5">
                <div className="flex items-center gap-2"><UnreadDot tag={c.tag} /><TagLink project={project} tag={c.tag} /><span className="text-sm text-muted-foreground">{t('is ready; the tick can only offer it to you, to start in {worker}', { worker: c.worker })}</span></div>
                <Button asChild size="sm" variant="outline"><Link to={`${base}/orders/${encodeURIComponent(c.tag)}`}>{t('Open order')}</Link></Button>
              </Card>
            ))}
          </div>
        </Section>
      );
    case 'blocked':
      return <Section title={<><OctagonAlert className="size-4 text-destructive" />{t('Blocked, failed or dropped')}</>} count={g.count}><div className="grid gap-2">{g.orders.map(o => <StuckRow key={o.tag} project={project} o={o} />)}</div></Section>;
    case 'problems':
      return (
        <Section title={<><AlertTriangle className="size-4 text-warning" />{t('Problems')}</>} count={g.count}>
          <div className="grid gap-2">
            {g.problems.map((p, i) => (
              <Card key={i} className="border-warning/40 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <UnreadDot tag={p.tag} />{p.tag && <TagLink project={project} tag={p.tag} />}
                  <span>{p.tag ? p.text.replace(new RegExp(`^${p.tag}: `), '') : p.text}</span>
                  <Badge tone="outline" className="ml-auto">{p.kind}</Badge>
                </div>
                {p.evidence && p.evidence.length > 0 && <ul className="mt-1.5 grid gap-0.5 rounded-md bg-muted px-3 py-1.5 font-mono text-xs">{p.evidence.map((line, j) => <li key={j} className="break-words">{line}</li>)}</ul>}
                {p.kind === 'lease-expired' && <div className="mt-1.5 text-xs"><Link className="text-primary hover:underline" to={`${base}/workers`}>{t('Open the resources to reclaim it')}</Link></div>}
              </Card>
            ))}
          </div>
        </Section>
      );
  }
}

export function NeedsPage() {
  const project = useProjectId();
  const q = useOverview(project);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  const groups = groupNeedsYou(q.data).sort((a, b) => (a.id === 'review' ? -1 : b.id === 'review' ? 1 : 0));
  const orderGroups = groups.filter(g => g.id !== 'problems');
  const o = q.data;
  return (
    <div>
      <PageHeader title={t('Needs you')} count={orderGroups.reduce((n, g) => n + g.count, 0)}>
        {o.name} · {t('{n} orders', { n: Object.values(o.stages).reduce((a, b) => a + (b ?? 0), 0) })} · {t('read {when}', { when: ago(o.at) })}
      </PageHeader>
      {o.error && <div className="mb-4"><ErrorBox error={o.error} /></div>}
      {groups.length === 0 && <EmptyState icon={<CheckCircle2 />} title={t('Nothing needs you')}>{t('Nothing is waiting for you. The workers carry on.')}</EmptyState>}
      {groups.map(g => <div key={g.id} id={g.id}><Group project={project} g={g} /></div>)}
      {o.running.items.length > 0 && (
        <Section title={t('Running')} count={o.running.items.length}>
          <Card className="divide-y">
            {o.running.items.map(r => (
              <div key={r.tag} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <UnreadDot tag={r.tag} /><TagLink project={project} tag={r.tag} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                <span className="text-xs text-muted-foreground">{r.run?.worker}</span>
                {stepText(r.progress) && <Badge tone="outline" title={r.progress?.current}>{stepText(r.progress)}</Badge>}
                <span className="text-xs text-muted-foreground tabular-nums">{r.run ? t('started {ago}', { ago: ago(r.run.started) }) : ''}</span>
                {r.quietMinutes !== undefined && <Badge tone={r.quietMinutes > 60 ? 'danger' : r.quietMinutes > 45 ? 'warning' : 'neutral'}>{t('{n} min without a commit', { n: r.quietMinutes })}</Badge>}
              </div>
            ))}
          </Card>
        </Section>
      )}
    </div>
  );
}
