import { useState } from 'react';
import { Link } from 'react-router';
import type { ProducerChatView, ProducerWorkspace } from '@api';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { TagLink } from './common';
import { CleanPlanItems } from './ProducerRoundFacts';
import { ProducerGoalFacts } from './ProducerGoalFacts';
import { t } from '@/i18n';

export type Decide = (kind: 'action' | 'direction', id: string, accept: boolean, edit?: { note?: string; reason?: string }) => Promise<boolean | void> | void;
export function ProducerCards({ project, data, questions = [], busy, decide }: { project: string; data: ProducerChatView; questions?: ProducerWorkspace['questions']; busy?: boolean; decide?: Decide }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ id: string; kind: 'action' | 'direction'; reject: boolean; text: string } | null>(null);
  const actions = data.actions.filter(a => ['proposed', 'would-do', 'superseded'].includes(a.status));
  const directions = data.directionProposals.filter(p => p.status === 'proposed');
  const cards = [...actions.map(a => ({ id: a.id, at: a.at, action: a, direction: undefined, question: undefined })), ...directions.map(d => ({ id: d.id, at: d.at ?? data.messages.find(m => m.id === d.messageId)?.at ?? '', action: undefined, direction: d, question: undefined })), ...questions.map(q => ({ id: q.id, at: q.at, action: undefined, direction: undefined, question: q }))].sort((a, b) => b.at.localeCompare(a.at));
  const selectable = cards.filter(c => !c.question && c.action?.status !== 'superseded');
  const bulk = async (accept: boolean) => {
    for (const card of selectable.filter(c => selected.has(c.id))) if (await decide?.(card.action ? 'action' : 'direction', card.id, accept) === false) return;
    setSelected(new Set());
  };
  return <div className="grid gap-2">
    {selectable.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1"><input type="checkbox" aria-label={t('Select all')} checked={selectable.every(c => selected.has(c.id))} onChange={e => setSelected(e.target.checked ? new Set(selectable.map(c => c.id)) : new Set())} />{t('Select all')}</label>
      {selected.size > 0 && <><Button size="sm" disabled={busy} onClick={() => void bulk(true)}>{t('Accept selected')}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk(false)}>{t('Reject selected')}</Button></>}
    </div>}
    {cards.map(({ id, action: a, direction: d, question: q }) => {
      if (q) return <Card key={id} className="p-3 text-sm"><Badge tone="warning">{t('question')}</Badge> <TagLink project={project} tag={q.order} /><p className="mt-2 line-clamp-2">{q.text}</p></Card>;
      const superseded = a?.status === 'superseded';
      const kind = a ? 'action' : 'direction';
      return <Card key={id} className={`p-3 ${superseded ? 'bg-muted text-muted-foreground opacity-60' : ''}`} data-status={superseded ? 'superseded' : 'open'}>
        <div className="flex flex-wrap items-center gap-2">
          {!superseded && <input type="checkbox" aria-label={t('Select proposal')} checked={selected.has(id)} onChange={e => setSelected(old => { const next = new Set(old); if (e.target.checked) next.add(id); else next.delete(id); return next; })} />}
          <Badge tone={superseded ? 'neutral' : 'primary'}>{a ? t(a.kind) : t('Standing direction')}</Badge>
          {a?.target && <TagLink project={project} tag={a.target} />}{a?.order && <TagLink project={project} tag={a.order.tag} />}
          {superseded && <Badge>{t('superseded')}</Badge>}
        </div>
        {a && <p className="mt-2 text-xs text-muted-foreground">{t('rule')}: {a.ruleId} · {t(a.mode)}</p>}
        {a?.goalFacts && <ProducerGoalFacts facts={a.goalFacts} />}
        {a?.reviewCard && <Link to={a.reviewCard} className="mt-2 block text-sm text-primary hover:underline">{t('Acceptance review')}</Link>}
        <details className="mt-2 text-sm"><summary className="line-clamp-2 cursor-pointer whitespace-pre-wrap">{a?.note || a?.reason || a?.order?.title || d?.direction.priorities || t('Details')}</summary>
          <div className="mt-2 space-y-2 whitespace-pre-wrap break-words">{a && <><p>{a.note}</p><p>{a.reason}</p>{a.order && <><p>{a.order.title} · {a.order.kind}</p><p>{t('needs')}: {a.order.needs.join(', ') || '—'}</p><p>{a.order.body}</p></>}{a.cleanPlan && <CleanPlanItems plan={a.cleanPlan} />}{a.priority !== undefined && <p>{t('Priority')}: {a.priority}</p>}</>}{d && Object.entries(d.direction).map(([key, value]) => <p key={key}><strong>{t(key)}: </strong>{value}</p>)}</div>
        </details>
        {superseded ? <p className="mt-2 text-xs">{t(a.supersededReason ?? '')}</p> : <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => void decide?.(kind, id, true)}>{t('Accept')}</Button>
          {a && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ id, kind, reject: false, text: a.note ?? '' })}>{t('Edit')}</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog({ id, kind, reject: true, text: '' })}>{t('Reject')}</Button>
        </div>}
      </Card>;
    })}
    <Dialog open={!!dialog} onOpenChange={open => { if (!open) setDialog(null); }}><DialogContent>
      <DialogTitle>{dialog?.reject ? t('Reject proposal') : t('Edit and accept')}</DialogTitle>
      <DialogDescription>{dialog?.reject ? t('Optional reason') : t('Edit the note before accepting this proposal.')}</DialogDescription>
      <textarea aria-label={dialog?.reject ? t('Optional reason') : t('Note')} className="min-h-36 rounded border bg-background p-3" maxLength={16000} value={dialog?.text ?? ''} onChange={e => setDialog(old => old ? { ...old, text: e.target.value } : old)} />
      <Button disabled={busy} onClick={async () => { if (!dialog) return; if (await decide?.(dialog.kind, dialog.id, !dialog.reject, dialog.reject ? { reason: dialog.text } : { note: dialog.text }) !== false) setDialog(null); }}>{dialog?.reject ? t('Reject') : t('Accept')}</Button>
    </DialogContent></Dialog>
  </div>;
}
