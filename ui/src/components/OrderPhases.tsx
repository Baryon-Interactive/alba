import type { OrderPhase, OrderSummary } from '@api';
import { Badge } from '@/components/ui/badge';
import { t } from '@/i18n';

export function PhaseBadge({ phase }: { phase: NonNullable<OrderSummary['phase']> }) {
  return <Badge tone="outline">{t('{id} {index}/{count}', phase)}</Badge>;
}

export function PhasePlan({ id, plan }: { id: string; plan?: string }) {
  if (!plan) return null;
  return <details className="my-2 min-w-0 rounded-md border bg-card px-3 py-2 text-sm">
    <summary className="cursor-pointer font-medium">{t('Plan from phase {id}', { id })}</summary>
    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{plan}</pre>
  </details>;
}

export function PhaseStrip({ phases }: { phases: OrderPhase[] }) {
  return <section aria-label={t('Order phases')} className="mb-4 min-w-0">
    <ol className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-card p-3">
      {phases.map((p, i) => <li key={p.id} aria-current={p.state === 'current' ? 'step' : undefined} className="flex min-w-0 items-start gap-3">
        {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
        <div className="min-w-0 break-words">
          <span className={p.state === 'current' ? 'font-semibold text-primary' : 'font-medium'}>{p.id}</span>
          <span className="ml-2 text-xs text-muted-foreground">{p.state === 'done' ? t('Phase complete') : p.state === 'current' ? t('Current phase') : t('Upcoming phase')}</span>
          {p.worker && <div className="text-xs text-muted-foreground">{[p.worker, p.model].filter(Boolean).join(' · ')}</div>}
        </div>
      </li>)}
    </ol>
    {phases.map(p => <PhasePlan key={p.id} id={p.id} plan={p.plan} />)}
  </section>;
}
