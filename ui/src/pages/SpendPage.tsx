import { useState } from 'react';
import { AlertTriangle, Check, Coins } from 'lucide-react';
import type { SpendQuote } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Progress, Skeleton } from '@/components/ui/misc';
import { QuoteCard } from '@/components/QuoteCard';
import { Empty, ErrorBox, PageHeader, Section } from '@/components/common';
import { quoteStateText, quoteStateTone, spentPercent } from '@/lib/library';
import { ago, dateTime } from '@/lib/format';
import { errorText, useApproveSpend, useCredits, useProjectId, useSpend } from '@/lib/queries';
import { t } from '@/i18n';

const money = (n: number | null | undefined): string => (n === null ? t('unknown') : n === undefined ? '–' : String(n));

function ApproveDialog({ project, q, onClose }: { project: string; q: SpendQuote; onClose: () => void }) {
  const approve = useApproveSpend(project);
  const [cap, setCap] = useState(String(q.capRequested ?? q.total ?? ''));
  const [note, setNote] = useState('');
  const n = Number(cap);
  return (
    <Dialog open onOpenChange={o => { if (!o && !approve.isPending) onClose(); }}>
      <DialogContent>
        <DialogTitle>{t('Approve quote {id}?', { id: q.id })}</DialogTitle>
        <DialogDescription>{t('The spend is allowed up to the cap you give, not more. If the quote file is edited afterwards, the approval no longer counts.')}</DialogDescription>
        <div className="rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-sm">{q.service ?? q.id}: {q.items !== undefined ? t('{n} item(s)', { n: q.items }) : ''} · {t('total')} {money(q.total)}{q.estimate?.perItem !== undefined ? ` · ${t('about {n} each', { n: String(q.estimate.perItem) })}` : ''}</div>
        <div className="grid gap-1.5">
          <Label>{t('Cap')}</Label>
          <Input type="number" min={0} step="any" value={cap} onChange={e => setCap(e.target.value)} className="tabular-nums" autoFocus />
          {q.capRequested !== undefined && <div className="text-xs text-muted-foreground">{t('Asked for {n}', { n: q.capRequested })}</div>}
        </div>
        <div className="grid gap-1.5"><Label>{t('Note (optional)')}</Label><Textarea value={note} onChange={e => setNote(e.target.value)} className="min-h-16" /></div>
        {approve.isError && <ErrorBox error={errorText(approve.error)} />}
        <DialogFooter>
          <Button variant="ghost" disabled={approve.isPending} onClick={onClose}>{t('Back')}</Button>
          <Button variant="success" disabled={!(Number.isFinite(n) && n > 0) || approve.isPending} onClick={() => approve.mutate({ id: q.id, cap: n, note: note.trim() || undefined, fingerprint: q.fingerprint }, { onSuccess: onClose })}>{approve.isPending ? t('Working…') : t('Confirm: {verb}', { verb: t('approve') })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuoteFile({ project, q }: { project: string; q: SpendQuote }) {
  const [approving, setApproving] = useState(false);
  const pct = spentPercent(q);
  const cap = q.approval && !q.approval.stale ? q.approval.cap : undefined;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{q.id}</span>
        {q.service && <span className="font-medium">{q.service}</span>}
        {q.order && <span className="text-xs text-muted-foreground">{q.order}</span>}
        <Badge tone={quoteStateTone[q.state]}>{quoteStateText(q.state)}</Badge>
        {q.status && <Badge tone={q.statusKnown ? 'outline' : 'warning'} title={q.statusKnown ? undefined : t('not one of exact, estimate, unknown, unknown_pricing_contract_expired')}>{q.status}</Badge>}
        {q.created && <span className="ml-auto text-xs text-muted-foreground" title={dateTime(q.created)}>{ago(q.created)}</span>}
      </div>
      <div className="mt-1.5 text-sm tabular-nums">
        {q.items !== undefined && <>{t('{n} item(s)', { n: q.items })} · </>}{t('total')} {money(q.total)}
        {q.estimate && <> · {t('estimate')} {q.estimate.perItem !== undefined ? `${q.estimate.perItem} ${t('each')}` : ''}{q.estimate.total !== undefined ? ` = ${q.estimate.total}` : ''}</>}
        {q.capRequested !== undefined && <> · {t('cap asked')} {q.capRequested}</>}
      </div>
      {q.estimate?.basis && <p className="text-xs text-muted-foreground">{q.estimate.basis}</p>}
      {q.notes && <p className="mt-1 text-sm text-muted-foreground">{q.notes}</p>}
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">{q.file}{q.spendFile ? ` · ${q.spendFile}` : ''}</div>

      <div className="mt-3 grid gap-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
          <span>{cap !== undefined ? t('spent {spent} of {cap}', { spent: q.spent, cap }) : t('spent {spent}', { spent: q.spent })}</span>
          <span>{q.balance !== undefined ? t('wallet {n}', { n: q.balance }) : ''}{q.remaining !== undefined ? ` · ${t('{n} left', { n: q.remaining })}` : ''}</span>
        </div>
        {cap !== undefined && <Progress value={pct} tone={pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok'} />}
        {q.approval && <div className="text-xs text-muted-foreground">{q.approval.stale ? t('approved up to {cap} {when}, but the file changed since; it needs a new approval', { cap: q.approval.cap, when: ago(q.approval.at) }) : t('approved up to {cap} by {by} {when}', { cap: q.approval.cap, by: q.approval.by, when: ago(q.approval.at) })}{q.approval.source === 'external' ? ` · ${t('from the studio’s record')}` : ''}{q.approval.note ? ` · ${q.approval.note}` : ''}</div>}
      </div>

      {q.problems.length > 0 && (
        <ul className="mt-3 grid gap-1 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          {q.problems.map((p, i) => <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />{p}</li>)}
        </ul>
      )}
      {q.entries.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('Spend lines')} · {q.entries.length}</summary>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[34rem]">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2 font-medium">{t('When')}</th><th className="py-1 pr-2 font-medium">{t('What')}</th><th className="py-1 pr-2 text-right font-medium">{t('Credits')}</th><th className="py-1 pr-2 text-right font-medium">{t('Wallet')}</th><th className="py-1 font-medium">{t('Note')}</th></tr></thead>
              <tbody className="divide-y">
                {q.entries.map((e, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2 whitespace-nowrap text-muted-foreground">{e.at ? dateTime(e.at) : ''}</td>
                    <td className="py-1 pr-2">{[e.order, e.asset, e.op].filter(Boolean).join(' · ')}{e.status && e.status !== 'succeeded' ? <Badge tone="warning" className="ml-1">{e.status}</Badge> : null}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{e.credits}</td>
                    <td className="py-1 pr-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">{e.before !== undefined || e.after !== undefined ? `${e.before ?? '?'} → ${e.after ?? '?'}` : ''}</td>
                    <td className="py-1 text-muted-foreground">{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {q.state !== 'approved' && (
        <div className="mt-3 flex justify-end"><Button size="sm" onClick={() => setApproving(true)}><Check />{q.state === 'stale' ? t('Approve again with a cap') : t('Approve with a cap')}</Button></div>
      )}
      {approving && <ApproveDialog project={project} q={q} onClose={() => setApproving(false)} />}
    </Card>
  );
}

/** Quote and spend files of the project (read from its credits folder), with what was spent; and the quotes made on orders in alba itself. */
export function SpendPage() {
  const project = useProjectId();
  const q = useSpend(project);
  const own = useCredits(project);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  const d = q.data;
  const ownQuotes = own.data?.items ?? [];
  return (
    <div>
      <PageHeader title={<><Coins className="size-5" />{t('Spend')}</>} count={d.quotes.length}>
        {t('{p} waiting for approval, {a} approved, {s} changed after approval, {w} with something wrong', { p: d.counts.pending, a: d.counts.approved, s: d.counts.stale, w: d.counts.withProblems })}
      </PageHeader>
      {!d.enabled && <Empty>{t('This project has no credits section. Add "credits: dir" to the project file.')}</Empty>}
      {d.unreadable.length > 0 && (
        <details className="mb-4 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t('{n} file(s) could not be read as a quote', { n: d.unreadable.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.unreadable.map(u => <li key={u.file}><span className="font-mono">{u.file}</span>: {u.reason}</li>)}</ul>
        </details>
      )}
      {d.recordProblems.length > 0 && (
        <details className="mb-4 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer">{t('{n} line(s) of a records file could not be read', { n: d.recordProblems.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.recordProblems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </details>
      )}
      {d.quotes.length > 0 && <Section title={t('Quote files')} count={d.quotes.length}><div className="grid gap-3">{d.quotes.map(x => <QuoteFile key={x.file} project={project} q={x} />)}</div></Section>}
      {ownQuotes.length > 0 && (
        <Section title={t('Quotes on orders')} count={ownQuotes.length}>
          <div className="grid gap-3">{ownQuotes.map(x => <QuoteCard key={x.tag + x.id} project={project} quote={x} />)}</div>
        </Section>
      )}
      {d.enabled && d.quotes.length === 0 && ownQuotes.length === 0 && d.unreadable.length === 0 && <Empty>{t('No quotes yet.')}</Empty>}
    </div>
  );
}
