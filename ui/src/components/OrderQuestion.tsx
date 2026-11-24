import { useState } from 'react';
import type { OrderSummary } from '@api';
import { Send } from 'lucide-react';
import { ActionDialog } from './ActionDialog';
import { OptionsPicker } from './OptionsPicker';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { useAct } from '@/lib/queries';
import { t } from '@/i18n';

function questionOf(o: OrderSummary) {
  const outbox = o.unanswered?.find(q => q.kind === 'question');
  if (outbox) return { text: outbox.text };
  if (!o.actions.includes('answer') || o.waitingFor === 'card') return;
  return o.waitingQuestion ?? (o.report?.question ? { text: o.report.question, options: o.report.options } : undefined);
}

export function AnswerForm({ project, o, onDone }: { project: string; o: OrderSummary; onDone?: () => void }) {
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [own, setOwn] = useState(false);
  const act = useAct(project);
  const question = questionOf(o);
  const options = question?.options ?? [];
  return <>
    <blockquote className="mt-2 rounded-md border-l-[3px] border-primary bg-primary/6 px-3 py-2 text-sm whitespace-pre-wrap">{question?.text ?? o.why}</blockquote>
    {options.length > 0 && <OptionsPicker project={project} tag={o.tag} options={options} onDone={onDone} submit={(choice, note) => act.mutateAsync({ tag: o.tag, action: 'answer', choice, text: note || undefined })} />}
    {(options.length === 0 || own) && <div className="mt-3 flex items-end gap-2">
      <Textarea value={text} onChange={e => setText(e.target.value)} placeholder={t('Type your answer…')} className="min-h-14 flex-1" />
      <Button disabled={!text.trim()} onClick={() => setConfirm(true)}><Send />{t('Answer')}</Button>
    </div>}
    {options.length > 0 && !own && <button className="mt-2 text-xs text-primary hover:underline" onClick={() => setOwn(true)}>{t('Answer in your own words instead')}</button>}
    {confirm && <ActionDialog project={project} tag={o.tag} action="answer" open onOpenChange={setConfirm} onDone={onDone} initialText={text} context={question?.text} />}
  </>;
}

export function OrderQuestion({ project, o }: { project: string; o: OrderSummary }) {
  const [open, setOpen] = useState(false);
  const question = questionOf(o);
  if (!question) return null;
  return <div className="relative flex min-w-0 items-center gap-2 text-xs">
    <span className="min-w-0 flex-1 truncate" title={question.text}>{question.text}</span>
    {o.actions.includes('answer') && <button className="shrink-0 text-primary hover:underline" onClick={() => setOpen(true)}>{t('Answer')}</button>}
    {open && <Dialog open onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>{t('Answer')} · {o.tag}</DialogTitle><AnswerForm project={project} o={o} onDone={() => setOpen(false)} /></DialogContent></Dialog>}
  </div>;
}
