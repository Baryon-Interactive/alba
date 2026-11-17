import { useState } from 'react';
import type { OrderDetail } from '@api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ErrorBox } from './common';
import { dateTime } from '@/lib/format';
import { useFirstPassWrong, useOrder } from '@/lib/queries';
import { t } from '@/i18n';

export type FirstPassRunView = NonNullable<OrderDetail['firstPass']>;

export const firstPassLabel = (run: FirstPassRunView) =>
  run.status === 'running' ? 'running' : run.status === 'skipped' ? 'skipped' : (run.verdict?.verdict ?? 'unsure');

export function FirstPassVerdict({ project, tag, run: given }: { project: string; tag: string; run?: FirstPassRunView }) {
  const order = useOrder(project, tag);
  const wrong = useFirstPassWrong(project, tag);
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');
  const run = given ?? order.data?.firstPass;
  if (!run) return null;

  const label = firstPassLabel(run);
  const tone = label === 'pass' ? 'success' : label === 'send-back' ? 'danger' : label === 'running' ? 'primary' : label === 'skipped' ? 'neutral' : 'warning';

  return (
    <section id={`first-pass-${run.id}`} className="scroll-mt-4 space-y-3 rounded-md border p-3" data-first-pass>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{t('First-pass review')}</strong>
        <Badge tone={tone}>{t(label)}</Badge>
        {run.verdict?.confident && <Badge tone="outline">{t('confident')}</Badge>}
        {run.worker
          ? <span className="text-sm">{t('reviewed by {worker} ({family})', { worker: run.worker, family: run.model_family || 'unknown' })}</span>
          : run.delivering_worker && <span className="text-sm text-muted-foreground">{t('delivering worker: {worker}', { worker: run.delivering_worker })}</span>}
        {run.verdict && <span className="text-xs text-muted-foreground">{t('{n} items', { n: run.verdict.items.length })}</span>}
        {run.applied && <Badge tone="warning">{t('Sent back automatically')}</Badge>}
        {run.not_applied && <span className="text-xs text-muted-foreground">{t('Not sent back: {reason}', { reason: run.not_applied })}</span>}
      </div>
      {(run.verdict?.summary || run.reason) && (
        <p className="whitespace-pre-wrap break-words text-sm">{run.verdict?.summary ?? run.reason}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span className="font-mono">{run.id}</span></span>
        <span>{dateTime(run.started)}{run.ended ? ` → ${dateTime(run.ended)}` : ''}</span>
        {run.commit && <span className="break-all font-mono">{run.commit.slice(0, 12)}</span>}
      </div>
      {run.verdict?.note && (
        <div className="rounded-md bg-muted/40 p-2.5 text-sm">
          <strong>{t('Reviewer note')}:</strong>{' '}
          <span className="whitespace-pre-wrap break-words">{run.verdict.note}</span>
        </div>
      )}
      {!!run.verdict?.items.length && (
        <ul className="divide-y">
          {run.verdict.items.map((item, i) => (
            <li key={i} className="py-2 text-sm">
              <div className="flex items-start gap-2">
                <Badge tone={item.verdict === 'pass' ? 'success' : item.verdict === 'fail' ? 'danger' : 'warning'}>{t(item.verdict)}</Badge>
                <strong className="break-words">{item.item}</strong>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{item.evidence}</p>
            </li>
          ))}
        </ul>
      )}
      {run.disputed && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
          <strong>{t('Marked wrong')}:</strong>{' '}
          <span className="whitespace-pre-wrap break-words">{run.disputed.note}</span>
        </div>
      )}
      {run.applied && !run.disputed && (
        <div className="space-y-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setDisputing(v => !v)}>
            {t('Wrong send-back')}
          </Button>
          {disputing && (
            <div className="grid gap-2">
              <textarea
                className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder={t('Explain why the send-back was wrong (at least 10 characters)')}
              />
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={note.trim().length < 10 || wrong.isPending}
                  onClick={() => wrong.mutate(note.trim(), { onSuccess: () => { setDisputing(false); setNote(''); } })}
                >
                  {wrong.isPending ? t('Working…') : t('Record dispute')}
                </Button>
              </div>
              {wrong.isError && <ErrorBox error={wrong.error} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
