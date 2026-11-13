import { ArrowRightLeft, CheckCircle2, Circle, CircleDot, Eye, Layers, ListChecks } from 'lucide-react';
import type { MonitorView, ProgressView, ResourceView, Run } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress, Skeleton } from '@/components/ui/misc';
import { ErrorBox, Section, TagLink } from '@/components/common';
import { useProjectId, useReleaseLease, useResources } from '@/lib/queries';
import { ago, dateTime, minutes } from '@/lib/format';
import { checkLine, criterionText, deadlineText, monitorResultLabel, monitorResultTone, stepText, usedPercent } from '@/lib/monitoring';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** What the monitor of an order in stage `monitoring` is doing: the check, the conditions, the deadline and the last result. */
export function MonitorPanel({ m }: { m: MonitorView }) {
  return (
    <Section title={<><Eye className="size-4 text-primary" />{t('Monitor')}</>} actions={<Badge tone={monitorResultTone(m.lastResult)}>{monitorResultLabel(m.lastResult)}</Badge>}>
      <Card><CardContent>
        <dl className="grid gap-y-1 text-sm">
          <Row label={t('Check')}><span className="font-mono text-xs break-all">{checkLine(m.spec)}</span></Row>
          {m.spec.cwd && <Row label={t('Folder')}><span className="font-mono text-xs break-all">{m.spec.cwd}</span></Row>}
          <Row label={t('Done when')}>{criterionText(m.spec.done_when)}</Row>
          {m.spec.fail_when && <Row label={t('Failed when')}>{criterionText(m.spec.fail_when)}</Row>}
          <Row label={t('Deadline')}>{dateTime(m.deadline)} <span className="text-muted-foreground">({deadlineText(m.deadline)})</span></Row>
          <Row label={t('Checks')}>{m.checks}{m.lastCheckAt ? <span className="text-muted-foreground"> · {t('last {when}', { when: ago(m.lastCheckAt) })}</span> : null}</Row>
          {m.spec.note && <Row label={t('Note for the worker')}>{m.spec.note}</Row>}
        </dl>
        {m.tail && <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{m.tail}</pre>}
        <p className="mt-3 text-xs text-muted-foreground">{t('The order holds no worker slot while it is monitored. When a condition is met or the deadline passes, the same worker continues the same session, before new orders.')}</p>
      </CardContent></Card>
    </Section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-3"><dt className="w-32 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

/** The worker's own step list (`<TAG>.progress.json`). */
export function ProgressPanel({ p }: { p: ProgressView }) {
  return (
    <Section title={<><ListChecks className="size-4 text-primary" />{t('Steps')}</>} count={p.total} actions={<span className="text-xs text-muted-foreground">{stepText(p)} · {t('written {when}', { when: ago(p.at) })}</span>}>
      <Card><CardContent>
        <Progress value={p.total ? (p.done / p.total) * 100 : 0} className="mb-3" />
        <ol className="grid gap-1 text-sm">
          {p.plan.map((s, i) => {
            const done = /^(done|complete|completed|finished)$/.test(s.status);
            const doing = !done && s.step === p.current;
            return (
              <li key={i} className={cn('flex items-start gap-2', done && 'text-muted-foreground')}>
                {done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : doing ? <CircleDot className="mt-0.5 size-4 shrink-0 text-primary" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                <span className={cn(doing && 'font-medium')}>{s.step}</span>
              </li>
            );
          })}
        </ol>
        {p.note && <p className="mt-3 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-1.5 text-sm">{p.note}</p>}
      </CardContent></Card>
    </Section>
  );
}

/** On a run row: the order was handed over from another worker, and why. */
export function RotationNote({ r }: { r: Run }) {
  if (!r.rotatedFrom && !r.limit) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {r.rotatedFrom && <><ArrowRightLeft className="size-3.5 text-primary" /><span>{r.rotatedFrom.text ?? t('handed over from {from} to {to}: {reason}', { from: r.rotatedFrom.worker, to: r.worker, reason: r.rotatedFrom.reason })}</span>{r.rotatedFrom.paid && <Badge tone="warning">{t('paid')}</Badge>}</>}
      {r.limit && <Badge tone="warning">{r.limit === 'unreachable' ? t('endpoint unreachable') : r.limit === 'quota' ? t('usage window used up') : t('model service at capacity')}</Badge>}
      {r.handoffFile && <span className="font-mono">{r.handoffFile}</span>}
    </div>
  );
}

function Lease({ project, r, l }: { project: string; r: ResourceView; l: ResourceView['leases'][number] }) {
  const release = useReleaseLease(project);
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <TagLink project={project} tag={l.tag} />
      <span className="text-muted-foreground tabular-nums">{t('held {time}', { time: minutes(l.heldMinutes) })}</span>
      {l.expired && <Badge tone="warning">{t('longer than its lease')}</Badge>}
      {l.run && <span className="text-xs text-muted-foreground">{l.run}</span>}
      <Button
        size="sm" variant={l.expired ? 'default' : 'outline'} className="ml-auto" disabled={release.isPending}
        title={l.expired ? t('The lease ran out and was not released. Take it back if the run is gone.') : t('Take the lease back now. Only do this when the run is gone.')}
        onClick={() => release.mutate({ resource: r.name, tag: l.tag })}
      >{l.expired ? t('Reclaim') : t('Release lease')}</Button>
    </div>
  );
}

/** The shared resources of the project (`resources` in the project file): how many slots, who holds them, and a button to take back a lease that outlived its run. */
export function ResourcesSection() {
  const project = useProjectId();
  const q = useResources(project);
  if (q.isError) return <Section title={t('Resources')}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={t('Resources')}><Skeleton className="h-24" /></Section>;
  const list = q.data.resources;
  if (list.length === 0) return null;
  return (
    <Section title={<><Layers className="size-4" />{t('Resources')}</>} count={list.length}>
      <div className="grid gap-3 xl:grid-cols-2">
        {list.map(r => (
          <Card key={r.name} className="overflow-hidden">
            <div className="p-3.5 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-semibold">{r.name}</span>
                {r.exclusive && <Badge tone="warning">{t('exclusive: blocks {kinds}', { kinds: r.blocks.join(', ') || t('nothing') })}</Badge>}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t('{used} of {slots} in use', { used: r.used, slots: r.slots })}</span>
              </div>
              {r.note && <p className="mt-1 text-xs text-muted-foreground">{r.note}</p>}
              <Progress value={usedPercent(r.used, r.slots)} tone={r.used >= r.slots ? 'warn' : 'ok'} className="mt-2" />
            </div>
            {r.leases.length === 0
              ? <div className="px-4 pb-3 text-xs text-muted-foreground">{t('Free.')}</div>
              : <div className="divide-y border-t">{r.leases.map(l => <Lease key={l.tag} project={project} r={r} l={l} />)}</div>}
          </Card>
        ))}
      </div>
    </Section>
  );
}
