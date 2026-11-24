import { CalendarClock, Pause, Play, RotateCw } from 'lucide-react';
import type { ScheduleView } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, Section, TagLink } from '@/components/common';
import { errorText, useScheduleActions, useSchedules } from '@/lib/queries';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';

function stateBadge(s: ScheduleView) {
  if (s.state === 'disabled') return <Badge tone="neutral">{t('disabled')}</Badge>;
  if (s.autoPaused) return <Badge tone="danger">{t('paused (auto)')}</Badge>;
  if (s.state === 'paused') return <Badge tone="warning">{t('paused')}</Badge>;
  return <Badge tone="success">{t('active')}</Badge>;
}

export function SchedulesSection({ project }: { project: string }) {
  const q = useSchedules(project);
  const actions = useScheduleActions(project);
  const busy = actions.run.isPending || actions.pause.isPending || actions.resume.isPending;
  const err = actions.run.error ?? actions.pause.error ?? actions.resume.error;

  if (q.isError) return <Section title={t('Schedules')}><ErrorBox error={q.error} /></Section>;
  if (!q.data) return <Section title={t('Schedules')}><Skeleton className="h-24" /></Section>;

  const list = q.data.schedules;

  return (
    <Section title={<><CalendarClock className="size-4 text-primary" />{t('Schedules')}</>} count={list.length}>
      {err && <div className="mb-3"><ErrorBox error={errorText(err)} /></div>}
      {list.length === 0 ? (
        <Empty>{t('No schedules configured (add schedules: in alba.yaml).')}</Empty>
      ) : (
        <Card className="divide-y">
          {list.map(s => (
            <div key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{s.id}</span>
                  {stateBadge(s)}
                  <Badge tone="outline">{s.cadence}</Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('{open}/{max} open', { open: s.openCount, max: s.maxOpen })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{t('Next')}: {s.nextAt ? `${dateTime(s.nextAt)} (${ago(s.nextAt)})` : '—'}</span>
                  <span>
                    {t('Last fire')}:{' '}
                    {!s.lastFire ? (
                      '—'
                    ) : s.lastFire.status === 'created' ? (
                      <>
                        {dateTime(s.lastFire.firedAt)} ? {t('created')}
                        {s.lastFire.orderTag && <> · <TagLink project={project} tag={s.lastFire.orderTag} /></>}
                      </>
                    ) : (
                      <>
                        {dateTime(s.lastFire.firedAt)} · {t(s.lastFire.status)}{s.lastFire.reason ? ` (${s.lastFire.reason})` : ''}
                      </>
                    )}
                  </span>
                </div>
                <div className="text-xs">
                  {t('Spend (7 days)')} {s.spend7dUsd === 'unknown' ? t('unknown') : `$${s.spend7dUsd}`}
                  {s.healthReason && <span className="ml-2 text-warning">{s.healthReason}</span>}
                </div>
                {!!s.history?.length && <details className="text-xs">
                  <summary className="cursor-pointer">{t('History')}</summary>
                  <ol className="mt-2 space-y-2">
                    {s.history.map(h => <li key={h.plannedAt} className="break-words">
                      {h.firstPlannedAt && <>{dateTime(h.firstPlannedAt)} &ndash; </>}{dateTime(h.plannedAt)} ? {t(h.status)}
                      {h.count && <> ?{h.count}</>}
                      {h.orderTag && <> ? <TagLink project={project} tag={h.orderTag} /></>}
                      {h.reason && <> ? {h.reason}</>}{h.precheck && <> ? {t('precheck bypassed')}</>}
                      {h.output && <pre className="whitespace-pre-wrap break-all">{h.output}</pre>}
                    </li>)}
                  </ol>
                </details>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.run.mutate(s.id)}>
                  <Play className="size-3.5" />{t('Run now')}
                </Button>
                {s.paused ? (
                  <Button size="sm" variant="default" disabled={busy} onClick={() => actions.resume.mutate(s.id)}>
                    <RotateCw className="size-3.5" />{t('Resume')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy || s.state === 'disabled'} onClick={() => actions.pause.mutate(s.id)}>
                    <Pause className="size-3.5" />{t('Pause')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}
