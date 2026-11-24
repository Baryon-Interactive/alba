import { Component, type ContextType, type ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, Inbox } from 'lucide-react';
import type { OrderSpend, OrderSummary, RunUsage, Stage, WaitingFor } from '@api';
import { Badge } from '@/components/ui/badge';
import { stageLabel } from '@/lib/stages';
import { statusTone } from '@/components/StatusPalette';
import { tokens } from '@/lib/format';
import { costLabel } from '@/lib/spend';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

export const StageBadge = ({ stage, waitingFor }: { stage: Stage; waitingFor?: WaitingFor }) => <Badge tone={statusTone[stage]}>{stageLabel(stage, waitingFor)}</Badge>;

export function PageHeader({ title, count, actions, children }: { title: ReactNode; count?: number; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-[22px] leading-tight font-semibold tracking-[-0.02em]">
          {title}
          {count !== undefined && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">{count}</span>}
        </h1>
        {children && <div className="mt-1 max-w-3xl text-sm text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, count, children, className, actions }: { title: ReactNode; count?: number; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cn('mb-6', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.005em]">
          {title}
          {count !== undefined && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      {icon ?? <Inbox className="size-4 shrink-0 opacity-60" />}
      <div>{children}</div>
    </div>
  );
}

/** A page-level empty state: what this space is for and how to fill it. Rows inside cards keep using `Empty`. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-brand/15 text-primary [&_svg]:size-5">{icon ?? <Inbox />}</div>
      {title && <div className="mt-4 text-[15px] font-semibold tracking-[-0.01em]">{title}</div>}
      {children && <div className="mt-1.5 max-w-lg text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function UnknownTotal({ error }: { error: unknown }) {
  return <div role="alert" className="grid gap-1"><strong>{t('Total')} · {t('unknown')}</strong><ErrorBox error={error} /></div>;
}

export class SectionBoundary extends Component<{ title: string; children: ReactNode }, { error?: Error; retrying: boolean }> {
  static contextType = QueryClientContext;
  declare context: ContextType<typeof QueryClientContext>;
  state: { error?: Error; retrying: boolean } = { retrying: false };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)), retrying: false };
  }
  retry = async () => {
    this.setState({ retrying: true });
    try {
      await this.context?.invalidateQueries();
      this.setState({ error: undefined, retrying: false });
    } catch (error) {
      this.setState(SectionBoundary.getDerivedStateFromError(error));
    }
  };
  render() {
    if (!this.state.error) return this.props.children;
    return <section role="alert" className="rounded-lg border bg-card p-3">
      <h2 className="mb-2 font-semibold">{this.props.title}</h2><ErrorBox error={this.state.error} />
      <button className="mt-2 text-sm text-primary hover:underline" disabled={this.state.retrying} onClick={this.retry}>{t('Retry')}</button>
    </section>;
  }
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 break-words">{msg}</div>
    </div>
  );
}

export const TagLink = ({ project, tag, className }: { project: string; tag: string; className?: string }) => (
  <Link to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(tag)}`} className={cn('font-mono text-[13px] font-semibold hover:underline', className)}>{tag}</Link>
);

/** Tokens and cost of one run or of an order. An estimate is marked; a log without numbers says unknown, never $0. */
export function UsageText({ usage }: { usage?: RunUsage | OrderSpend }) {
  if (!usage) return <span className="text-muted-foreground">–</span>;
  if ('source' in usage && usage.source === 'unknown') return <span className="text-muted-foreground">{t('unknown')}</span>;
  const cost = costLabel(usage.cost_usd, 'source' in usage ? usage.cost_estimated : usage.estimated);
  return (
    <span className="tabular-nums">
      {tokens(usage.total_tokens)} {t('tokens')} · <span className={cost.known ? undefined : 'text-muted-foreground'}>{cost.text}</span>
      {cost.estimated && <span className="ml-1 text-[11px] text-muted-foreground">({t('estimate')})</span>}
    </span>
  );
}

export function orderMeta(o: OrderSummary): string[] {
  return [o.kind, o.heavy ? `heavy:${o.heavy}` : '', o.worker ?? ''].filter(Boolean);
}
