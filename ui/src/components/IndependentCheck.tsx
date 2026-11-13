import type { OrderDetail } from '@api';
import { Badge } from './ui/badge';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

type Check = NonNullable<NonNullable<OrderDetail['acceptance']>['independent']>[number];
export const checkVerdict = (run: Check) => run.status === 'running' ? 'running' : run.status === 'passed' ? 'pass' : 'fail';
export function IndependentCheck({ run }: { run: Check }) {
  return <section id={`independent-check-${run.id}`} className="scroll-mt-4 space-y-3 rounded-md border p-3" data-independent-check>
    <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{t('Independent check')}</strong><Badge tone={run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'primary'}>{t(checkVerdict(run))}</Badge><span className="text-sm">{t('checked by {worker}: {verdict}', { worker: run.worker, verdict: t(checkVerdict(run)) })}</span><span className="text-xs text-muted-foreground">{t('{n} items', { n: run.verdict?.checked.length ?? 0 })}</span></div>
    <p className="whitespace-pre-wrap break-words text-sm">{run.reason ?? run.verdict?.summary}</p>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{t('Verifier run')}: <span className="font-mono">{run.id}</span></span><span>{dateTime(run.started)}{run.ended ? ` → ${dateTime(run.ended)}` : ''}</span><span className="break-all font-mono">{run.branch} · {run.commit.slice(0, 12)}</span></div>
    {!!run.verdict?.checked.length && <ul className="divide-y">{run.verdict.checked.map((item, i) => <li key={i} className="py-2 text-sm"><div className="flex items-start gap-2"><Badge tone={item.verdict === 'pass' ? 'success' : item.verdict === 'fail' ? 'danger' : 'warning'}>{t(item.verdict)}</Badge><strong className="break-words">{item.item}</strong></div><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{item.evidence}</p></li>)}</ul>}
  </section>;
}
