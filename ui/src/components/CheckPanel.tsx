import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { CheckRef, OrderDetail } from '@api';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorBox } from '@/components/common';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { errorText } from '@/lib/queries';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

const refTone: Record<CheckRef['status'], Tone> = { same: 'success', different: 'danger', missing: 'warning', new: 'primary' };
const refLabel = (s: CheckRef['status']) => (s === 'same' ? t('same') : s === 'different' ? t('different') : s === 'missing' ? t('missing') : t('new'));

/** The last check of the order: the general items, then the reference values against what the results file says. */
export function CheckPanel({ project, detail }: { project: string; detail: OrderDetail }) {
  const client = useQueryClient();
  const tag = detail.order.tag;
  const again = useMutation({
    mutationFn: () => api.check(tag, { project }),
    onSuccess: r => { toast[r.ok ? 'success' : 'warning'](r.ok ? t('The check passed.') : t('The check found differences.')); void client.invalidateQueries({ queryKey: keys.order(project, tag) }); },
  });
  const c = detail.lastCheck;
  const action = (
    <Button size="sm" variant="outline" disabled={again.isPending} onClick={() => again.mutate()}><RefreshCw className={again.isPending ? 'animate-spin' : ''} />{t('Run the check again')}</Button>
  );
  if (!c) return <Empty icon={<CheckCircle2 className="size-6 opacity-60" />}><div className="grid justify-items-center gap-3">{t('No check has been run for this order.')}{action}{again.isError && <ErrorBox error={errorText(again.error)} />}</div></Empty>;

  const refs = c.refs;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {c.ok ? <Badge tone="success"><CheckCircle2 />{t('all passed')}</Badge> : <Badge tone="danger"><XCircle />{t('differs or failed')}</Badge>}
          <span className="text-xs text-muted-foreground">{dateTime(c.at)} · {t('against')} <span className="font-mono">{c.base}</span></span>
        </div>
        {action}
      </div>
      {again.isError && <ErrorBox error={errorText(again.error)} />}

      <Card>
        <div className="border-b px-4 py-2 text-sm font-semibold">{t('General items')}</div>
        <div className="divide-y">
          {c.general.map(i => (
            <div key={i.name} className="flex items-start gap-2.5 px-4 py-2 text-sm">
              {i.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
              <span className="w-64 shrink-0 font-medium">{i.name}</span>
              <span className="min-w-0 text-muted-foreground">{i.detail}</span>
            </div>
          ))}
        </div>
      </Card>

      {refs && (
        <Card>
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-semibold">{t('Reference values')}</span>
            <span className="text-xs text-muted-foreground">{t('{n} same', { n: refs.same })}{c.results?.length ? ` · ${t('results in')}: ${c.results.join(', ')}` : ''}</span>
          </div>
          {refs.other.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t('Every reference value matches.')}</div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">{t('Name')}</th><th className="px-2 py-1.5 font-medium">{t('State')}</th><th className="px-2 py-1.5 font-medium">{t('Reference')}</th><th className="px-2 py-1.5 font-medium">{t('Got')}</th><th className="px-4 py-1.5 font-medium">{t('Source')}</th></tr></thead>
              <tbody className="divide-y">
                {refs.other.map(r => (
                  <tr key={r.name}>
                    <td className="px-4 py-2 font-mono text-[13px]">{r.name}</td>
                    <td className="px-2 py-2"><Badge tone={refTone[r.status]}>{refLabel(r.status)}</Badge></td>
                    <td className="px-2 py-2 font-mono text-xs">{r.reference ?? '–'}</td>
                    <td className="px-2 py-2 font-mono text-xs">{r.got ?? '–'}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{[r.from, r.why].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
