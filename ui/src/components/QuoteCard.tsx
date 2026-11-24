import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import type { Quote } from '@api';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Progress } from '@/components/ui/misc';
import { UnreadDot } from './OrderAttention';
import { ErrorBox, TagLink } from '@/components/common';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { errorText } from '@/lib/queries';
import { ago, dateTime } from '@/lib/format';
import { quoteSummary } from '@/lib/spend';
import { t } from '@/i18n';

const statusTone: Record<Quote['status'], Tone> = { pending: 'warning', approved: 'success', rejected: 'neutral' };
const statusText = (s: Quote['status']) => (s === 'pending' ? t('waiting for approval') : s === 'approved' ? t('approved') : t('rejected'));

function useQuoteWrite(project: string, tag: string) {
  const client = useQueryClient();
  const done = () => { for (const k of [keys.credits(project), keys.order(project, tag), keys.overview(project), keys.workers(project)]) void client.invalidateQueries({ queryKey: k }); };
  return {
    approve: useMutation({ mutationFn: (v: { id: string; cap: number; note?: string }) => api.approveQuote(tag, v.id, { project, cap: v.cap, note: v.note }), onSuccess: () => { toast.success(t('Quote approved')); done(); } }),
    reject: useMutation({ mutationFn: (v: { id: string; note?: string }) => api.rejectQuote(tag, v.id, { project, note: v.note }), onSuccess: () => { toast.success(t('Quote rejected')); done(); } }),
  };
}

/** One quote for a paid resource: what is asked, the cap that was allowed, what was spent. A waiting quote can be approved with a cap of the person's own. */
export function QuoteCard({ project, quote: q, showOrder = true }: { project: string; quote: Quote; showOrder?: boolean }) {
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [cap, setCap] = useState(String(q.capRequested));
  const [note, setNote] = useState('');
  const { approve, reject } = useQuoteWrite(project, q.tag);
  const capNum = Number(cap);
  const capOk = Number.isFinite(capNum) && capNum > 0;
  const limit = q.approval?.cap;
  const pct = limit ? Math.min(100, (q.spent / limit) * 100) : 0;
  const pending = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        {showOrder && <UnreadDot tag={q.tag} />}{showOrder && <TagLink project={project} tag={q.tag} />}
        <span className="font-medium">{q.service}</span>
        <Badge tone={statusTone[q.status]}>{statusText(q.status)}</Badge>
        <span className="ml-auto text-xs text-muted-foreground" title={dateTime(q.created)}>{t('asked {ago} by {by}', { ago: ago(q.created), by: q.by })}</span>
      </div>
      <div className="mt-1.5 text-sm">{quoteSummary(q)}</div>
      {q.note && <p className="mt-1 text-sm text-muted-foreground">{q.note}</p>}

      {q.status === 'approved' && limit !== undefined && (
        <div className="mt-3 grid gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
            <span>{t('spent {spent} of {cap} {unit}', { spent: q.spent, cap: limit, unit: q.unit })}</span>
            <span>{t('{n} {unit} left', { n: q.remaining ?? Math.max(0, limit - q.spent), unit: q.unit })}</span>
          </div>
          <Progress value={pct} tone={pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok'} />
          {q.approval && <div className="text-xs text-muted-foreground">{t('approved by {by} {ago}', { by: q.approval.by, ago: ago(q.approval.at) })}{q.approval.note ? ` · ${q.approval.note}` : ''}</div>}
        </div>
      )}
      {q.status === 'rejected' && q.approval?.note && <p className="mt-1 text-xs text-muted-foreground">{q.approval.note}</p>}

      {q.ledger.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('Ledger')} · {q.ledger.length}</summary>
          <table className="mt-1 w-full">
            <tbody className="divide-y">
              {q.ledger.map((l, i) => (
                <tr key={i}><td className="py-1 pr-2 whitespace-nowrap text-muted-foreground">{dateTime(l.at)}</td><td className="py-1 pr-2 text-right tabular-nums">{l.amount} {q.unit}</td><td className="py-1 pr-2">{l.what}</td><td className="py-1 text-right text-muted-foreground">{l.by}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {q.status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setMode('reject')}><X />{t('Reject')}</Button>
          <Button size="sm" onClick={() => setMode('approve')}><Check />{t('Approve with a cap')}</Button>
        </div>
      )}

      <Dialog open={mode !== null} onOpenChange={o => { if (!o && !pending) { setMode(null); approve.reset(); reject.reset(); } }}>
        <DialogContent>
          <DialogTitle>{mode === 'approve' ? t('Approve the quote for {tag}?', { tag: q.tag }) : t('Reject the quote for {tag}?', { tag: q.tag })}</DialogTitle>
          <DialogDescription>{mode === 'approve' ? t('The worker may spend up to the cap you give, not more. It stops at the gate when the cap is reached.') : t('The worker is not allowed to spend on this quote.')}</DialogDescription>
          <div className="rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-sm">{q.service}: {quoteSummary(q)}</div>
          {mode === 'approve' && (
            <div className="grid gap-1.5">
              <Label>{t('Cap ({unit})', { unit: q.unit })}</Label>
              <Input type="number" min={0} step="any" value={cap} onChange={e => setCap(e.target.value)} className="tabular-nums" autoFocus />
              <div className="text-xs text-muted-foreground">{t('Asked for {n} {unit}', { n: q.capRequested, unit: q.unit })}</div>
            </div>
          )}
          <div className="grid gap-1.5"><Label>{t('Note (optional)')}</Label><Textarea value={note} onChange={e => setNote(e.target.value)} className="min-h-16" /></div>
          {error && <ErrorBox error={errorText(error)} />}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setMode(null)}>{t('Back')}</Button>
            {mode === 'approve'
              ? <Button variant="success" disabled={!capOk || pending} onClick={() => approve.mutate({ id: q.id, cap: capNum, note: note.trim() || undefined }, { onSuccess: () => setMode(null) })}>{pending ? t('Working…') : t('Confirm: {verb}', { verb: t('approve') })}</Button>
              : <Button variant="destructive" disabled={pending} onClick={() => reject.mutate({ id: q.id, note: note.trim() || undefined }, { onSuccess: () => setMode(null) })}>{pending ? t('Working…') : t('Confirm: {verb}', { verb: t('reject') })}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
