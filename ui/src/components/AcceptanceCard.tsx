import type { OrderDetail } from '@api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ErrorBox } from './common';
import { ReportEvidence } from './ReportEvidence';
import { useAct } from '@/lib/queries';
import { t } from '@/i18n';
import { IndependentCheck } from './IndependentCheck';

export function AcceptanceCard({ project, card, canApprove = false }: { project: string; card: NonNullable<OrderDetail['acceptance']>; canApprove?: boolean }) {
  const act = useAct(project);
  const trial = card.trial;
  const ready = (card.pipelineRequired === false || trial?.status === 'passed') && card.lint.every(i => i.ok);
  return <Card id="acceptance" className="grid gap-3 p-4">
    <div className="flex flex-wrap items-center gap-2"><strong>{t('Acceptance review')}</strong>{card.pipelineRequired !== false && <Badge tone={ready ? 'success' : trial?.status === 'failed' ? 'danger' : 'warning'}>{trial?.status ?? t('Waiting for trial')}</Badge>}</div>
    <div className="flex flex-wrap gap-2"><span className="text-sm">{t('Delivery lint')}:</span>{card.lint.length ? card.lint.map(i => <Badge key={i.name} title={i.detail} tone={i.ok ? 'success' : 'danger'}>{i.name}: {i.ok ? 'PASS' : 'FAIL'}</Badge>) : <span className="text-sm text-muted-foreground">{t('No optional lint checks configured')}</span>}</div>
    {trial?.reason && <p className="whitespace-pre-wrap break-words text-sm">{trial.reason}</p>}
    {card.independentRequired && !card.independent?.length && <p className="text-sm text-muted-foreground">{t('Waiting for independent check')}</p>}
    {card.independent?.slice().reverse().map(run => <IndependentCheck key={run.id} run={run} />)}
    {trial?.steps.map((s, i) => <details key={i} className="text-sm"><summary className="cursor-pointer"><Badge tone={s.status === 'passed' ? 'success' : s.status === 'failed' ? 'danger' : 'neutral'}>{s.status}</Badge> {s.name} · {s.duration_ms} ms</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{s.tail}</pre></details>)}
    <details className="text-sm"><summary className="cursor-pointer">{t('Changed paths')} ({card.changed.length})</summary><ul className="mt-2 space-y-1 font-mono text-xs">{card.changed.map(file => <li key={file}>{file}</li>)}</ul></details>
    <ReportEvidence project={project} tag={card.tag} evidence={card.images} commits={[]} />
    {canApprove && <Button className="justify-self-start" variant="success" disabled={!ready || act.isPending} onClick={() => act.mutate({ tag: card.tag, action: 'approve' })}>{act.isPending ? t('Working…') : t('Accept and merge')}</Button>}
    {act.isError && <ErrorBox error={act.error} />}
  </Card>;
}
