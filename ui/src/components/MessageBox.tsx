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

export function MessageBox({ project, tag, d }: { project: string; tag: string; d: OrderDetail }) {
  const say = useSay(project);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<string>();
  const [restart, setRestart] = useState(false);
  const open = d.runs.some(r => !r.ended);
  const canSend = !['merged', 'cancelled', 'planned'].includes(d.stage);
  const thread = d.thread ?? [];
  const labels: Record<string, string> = { inbox: t('You'), question: t('Question'), blocker: t('Blocker'), note: t('Worker note'), eta: t('ETA'), report: t('Final report'), rework: t('Rework'), answer: t('Answer'), message: t('Message') };
  const deliveries = { sent: t('Sent'), read: t('Read'), answered: t('Answered') };
  const send = () => {
    if (!text.trim()) return;
    say.mutate({ tag, text: text.trim(), restart, reply }, { onSuccess: () => { setText(''); setRestart(false); setReply(undefined); } });
  };
  return <Section title={t('Thread')} count={thread.length}>
    <Card className="mb-3 max-h-80 divide-y overflow-auto">{thread.map(m => <div key={m.id} className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{dateTime(m.at)}</span><span>{labels[m.kind] ?? t('Worker note')}</span>{d.pendingNotes.some(n => n.at === m.at && n.text === m.text) && <Badge tone="primary">{t('Queued for the next run')}</Badge>}{m.delivery && <Badge tone={m.delivery === 'answered' ? 'success' : 'outline'}>{deliveries[m.delivery]}</Badge>}{'reply' in m && m.reply && <span>{t('Reply to {id}', { id: m.reply })}</span>}</div>
      <p className="mt-1 whitespace-pre-wrap">{m.text}</p>
      {'options' in m && m.options?.map((o, i) => <Button key={i} className="mt-2 mr-2" size="sm" variant="outline" disabled={!open} onClick={() => { setReply(m.id); setText(o); }}>{o}</Button>)}
      {['question', 'blocker'].includes(m.kind) && m.delivery !== 'answered' && <Button className="mt-2" size="sm" variant="outline" disabled={!open} onClick={() => setReply(m.id)}>{t('Reply')}</Button>}
    </div>)}</Card>
    <Card><CardContent className="grid gap-2">
      {d.commitNudge && d.commitNudge.count >= 2 && <p className="text-sm text-warning">{t('{tag}: nudged twice to commit ({n} changed files, quiet for {m} min).', { tag, n: d.commitNudge.files, m: d.commitNudge.minutes })}</p>}
      <Label htmlFor={`say-${tag}`}>{reply ? t('Reply to {id}', { id: reply }) : t(open ? 'Leave a message for the open run' : 'Leave a message for the next run')}</Label>
      {reply && <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setReply(undefined)}>{t('Cancel reply')}</Button>}
      <Textarea id={`say-${tag}`} value={text} onChange={e => setText(e.target.value)} className="min-h-20" placeholder={t('It reads the inbox after each long command, and at least every 15 minutes.')} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={restart} onCheckedChange={v => setRestart(v === true)} disabled={!open || !!reply} />{t('Stop the run and send')}</label>
      <div className="flex items-center gap-2"><Button size="sm" disabled={say.isPending || !text.trim() || !canSend} onClick={send}>{say.isPending ? t('Working…') : t('Send')}</Button>{say.isError && <span className="text-xs text-destructive">{errorText(say.error)}</span>}</div>
      {!open && canSend && <p className="text-xs text-muted-foreground">{t('Messages wait in pending notes for the next run.')}</p>}
    </CardContent></Card>
  </Section>;
}
