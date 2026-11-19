import { useState } from 'react';
import type { OrderDetail } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/misc';
import { Label, Textarea } from '@/components/ui/input';
import { Section } from '@/components/common';
import { dateTime } from '@/lib/format';
import { errorText, useSay } from '@/lib/queries';
import { t } from '@/i18n';

export type MessageThreadEntry = NonNullable<OrderDetail['thread']>[number];
export type SayDelivery = NonNullable<OrderDetail['sayDelivery']>;

/** Human-readable state label (including timestamp when available) for a thread message. */
export function messageStateLabel(m: Pick<MessageThreadEntry, 'at' | 'delivery' | 'delivered_at' | 'via' | 'seen'>): string | undefined {
  if (!m.delivery) return undefined;
  if (m.delivery === 'sent') {
    return m.at ? t('Sent ({when})', { when: dateTime(m.at) }) : t('Sent');
  }
  if (m.delivery === 'delivered') {
    const when = m.delivered_at ? dateTime(m.delivered_at) : '';
    if (m.via === 'hook') return when ? t('Delivered via hook ({when})', { when }) : t('Delivered via hook');
    if (m.via === 'steer') return when ? t('Delivered via steer ({when})', { when }) : t('Delivered via steer');
    if (m.via === 'turn') return when ? t('Delivered via turn ({when})', { when }) : t('Delivered via turn');
    return when ? t('Delivered ({when})', { when }) : t('Delivered');
  }
  if (m.delivery === 'read') {
    return m.seen ? t('Read ({when})', { when: dateTime(m.seen) }) : t('Read');
  }
  return m.seen ? t('Answered ({when})', { when: dateTime(m.seen) }) : t('Answered');
}

/** Badge tone for a message delivery state. */
export function messageStateTone(delivery: MessageThreadEntry['delivery']): 'success' | 'primary' | 'outline' {
  if (delivery === 'answered') return 'success';
  if (delivery === 'delivered' || delivery === 'read') return 'primary';
  return 'outline';
}

/** Description shown before sending, naming the delivery path (`live`, `steer`, or `file`). */
export function sayDeliveryHint(mode: SayDelivery): string {
  if (mode === 'steer') return t('Delivery: steer — sent directly into the running Codex turn.');
  if (mode === 'live') return t('Delivery: live — delivered on the next tool or model call.');
  return t('Delivery: file — the open run reads the inbox after each commit, long command, or every 15 minutes.');
}

export function MessageBox({ project, tag, d }: { project: string; tag: string; d: OrderDetail }) {
  const say = useSay(project);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<string>();
  const [restart, setRestart] = useState(false);
  const open = d.runs.some(r => !r.ended);
  const canSend = !['merged', 'cancelled', 'planned'].includes(d.stage);
  const thread = d.thread ?? [];
  const deliveryMode: SayDelivery = d.sayDelivery ?? 'file';
  const labels: Record<string, string> = { inbox: t('You'), question: t('Question'), blocker: t('Blocker'), note: t('Worker note'), eta: t('ETA'), report: t('Final report'), rework: t('Rework'), answer: t('Answer'), message: t('Message') };
  const send = () => {
    if (!text.trim()) return;
    say.mutate({ tag, text: text.trim(), restart, reply }, { onSuccess: () => { setText(''); setRestart(false); setReply(undefined); } });
  };
  return <Section title={t('Thread')} count={thread.length}>
    <Card className="mb-3 max-h-80 divide-y overflow-auto">{thread.map(m => {
      const stateLabel = messageStateLabel(m);
      return <div key={m.id} className="px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{dateTime(m.at)}</span><span>{labels[m.kind] ?? t('Worker note')}</span>{d.pendingNotes.some(n => n.at === m.at && n.text === m.text) && <Badge tone="primary">{t('Queued for the next run')}</Badge>}{stateLabel && <Badge tone={messageStateTone(m.delivery)}>{stateLabel}</Badge>}{'reply' in m && m.reply && <span>{t('Reply to {id}', { id: m.reply })}</span>}</div>
        <p className="mt-1 whitespace-pre-wrap break-words">{m.text}</p>
        {'options' in m && m.options?.map((o, i) => <Button key={i} className="mt-2 mr-2" size="sm" variant="outline" disabled={!open} onClick={() => { setReply(m.id); setText(o); }}>{o}</Button>)}
        {['question', 'blocker'].includes(m.kind) && m.delivery !== 'answered' && <Button className="mt-2" size="sm" variant="outline" disabled={!open} onClick={() => setReply(m.id)}>{t('Reply')}</Button>}
      </div>;
    })}</Card>
    <Card><CardContent className="grid gap-2">
      {d.commitNudge && d.commitNudge.count >= 2 && <p className="text-sm text-warning">{t('{tag}: nudged twice to commit ({n} changed files, quiet for {m} min).', { tag, n: d.commitNudge.files, m: d.commitNudge.minutes })}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`say-${tag}`}>{reply ? t('Reply to {id}', { id: reply }) : t(open ? 'Leave a message for the open run' : 'Leave a message for the next run')}</Label>
        {open && <Badge tone={deliveryMode === 'file' ? 'outline' : 'primary'}>{deliveryMode}</Badge>}
      </div>
      {open && <p className="text-xs text-muted-foreground">{sayDeliveryHint(deliveryMode)}</p>}
      {reply && <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setReply(undefined)}>{t('Cancel reply')}</Button>}
      <Textarea id={`say-${tag}`} value={text} onChange={e => setText(e.target.value)} className="min-h-20" placeholder={open ? sayDeliveryHint(deliveryMode) : t('Messages wait in pending notes for the next run.')} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={restart} onCheckedChange={v => setRestart(v === true)} disabled={!open || !!reply} />{t('Stop the run and send')}</label>
      <div className="flex items-center gap-2"><Button size="sm" disabled={say.isPending || !text.trim() || !canSend} onClick={send}>{say.isPending ? t('Working…') : t('Send')}</Button>{say.isError && <span className="text-xs text-destructive">{errorText(say.error)}</span>}</div>
      {!open && canSend && <p className="text-xs text-muted-foreground">{t('Messages wait in pending notes for the next run.')}</p>}
    </CardContent></Card>
  </Section>;
}
