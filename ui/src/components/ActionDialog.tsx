import { useEffect, useState } from 'react';
import type { OrderAction, OrderPhase } from '@api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea, Label, Select } from '@/components/ui/input';
import { Tip } from '@/components/ui/misc';
import { actionExplain, actionLabel } from '@/lib/stages';
import { errorText, useAct, useWorkers } from '@/lib/queries';
import { t } from '@/i18n';
import { ErrorBox } from './common';

const NEEDS_TEXT: Partial<Record<OrderAction, 'note' | 'text'>> = { rework: 'note', answer: 'text' };
const variantOf = (a: OrderAction) => (a === 'approve' ? 'success' : a === 'cancel' ? 'destructive' : a === 'rework' ? 'default' : 'default') as 'success' | 'destructive' | 'default';

/** The second step of every action: nothing is sent before the person confirms here. */
export function ActionDialog({ project, tag, action, open, onOpenChange, initialText = '', context, branch, noBranch, onDone, phases }: {
  phases?: OrderPhase[];
  project: string; tag: string; action: OrderAction; open: boolean; onOpenChange: (open: boolean) => void; initialText?: string; context?: string; branch?: string; noBranch?: boolean; onDone?: () => void;
}) {
  const act = useAct(project);
  const [text, setText] = useState(initialText);
  const [branchText, setBranchText] = useState(branch ?? '');
  const [phase, setPhase] = useState('');
  const [worker, setWorker] = useState('');
  const workers = useWorkers(action === 'run' && open ? project : '');
  const askBranch = action === 'approve' && !!noBranch;
  const required = NEEDS_TEXT[action];
  useEffect(() => { if (open) { setText(initialText); setBranchText(branch ?? ''); setWorker(''); setPhase(''); act.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const body = { tag, action, ...(action === 'rework' && phase ? { phase } : {}), ...(required === 'text' ? { text: text.trim() } : text.trim() ? { note: text.trim() } : {}), ...(askBranch && branchText.trim() ? { branch: branchText.trim() } : {}), ...(action === 'run' && worker ? { worker } : {}) };
    act.mutate(body, { onSuccess: () => { onDone?.(); onOpenChange(false); } });
  };
  const blocked = (!!required && !text.trim()) || (askBranch && !branchText.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t('{action}: {tag}?', { action: actionLabel(action), tag })}</DialogTitle>
        <DialogDescription>{actionExplain(action)}</DialogDescription>
        {context && <div className="rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{context}</div>}
        {askBranch && (
          <div className="grid gap-1.5">
            <Label>{t('Branch of this work (recorded, then checked to be merged)')}</Label>
            <Input value={branchText} onChange={e => setBranchText(e.target.value)} placeholder="order/abc" className="font-mono text-[13px]" />
          </div>
        )}
        {action === 'rework' && phases?.length && <label className="grid gap-1.5">
          {t('Restart from phase')}
          <Select value={phase || phases[phases.length - 1].id} onChange={e => setPhase(e.target.value)}>
            {phases.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
          </Select>
        </label>}
        {action === 'run' && (
          <div className="grid gap-1.5">
            <Label>{t('Worker')}</Label>
            <Select value={worker} onChange={e => setWorker(e.target.value)}>
              <option value="">{t('The one the tick would choose (a held order needs a worker named)')}</option>
              {(workers.data?.workers ?? []).map(w => <option key={w.id} value={w.id}>{w.id}{w.model ? ` · ${w.model}` : ''}</option>)}
            </Select>
          </div>
        )}
        {(required || action === 'approve' || action === 'cancel' || action === 'hold' || action === 'stop') && (
          <div className="grid gap-1.5">
            <Label>{required === 'text' ? t('Your answer (required)') : required === 'note' ? t('Note for the next run (required)') : t('Note (optional)')}</Label>
            <Textarea autoFocus value={text} onChange={e => setText(e.target.value)} className="min-h-28 font-mono text-[13px]" />
          </div>
        )}
        {act.isError && <ErrorBox error={errorText(act.error)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
          <Button variant={variantOf(action)} disabled={blocked || act.isPending} onClick={submit}>
            {act.isPending ? t('Working…') : t('Confirm: {verb}', { verb: actionLabel(action) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Buttons for a list of actions; each opens the confirmation. Actions the stage does not allow are left out, or shown off with the reason. */
export function ActionButtons({ project, tag, actions, unavailable, only, size = 'sm', initialText, context, noBranch, phases }: {
  project: string; tag: string; actions: OrderAction[]; unavailable?: Partial<Record<OrderAction, string>>;
  phases?: OrderPhase[];
  only?: OrderAction[]; size?: 'sm' | 'default'; initialText?: Partial<Record<OrderAction, string>>; context?: string;
  /** The order has no branch recorded (it came from a table): next to Approve there is a box for the branch, which is recorded and checked. */
  noBranch?: boolean;
}) {
  const [open, setOpen] = useState<OrderAction | null>(null);
  const [branch, setBranch] = useState('');
  const list = (only ?? actions).filter(a => a !== 'answer' || only);
  return (
    <>
      {list.map(a => {
        const ok = actions.includes(a);
        if (!ok && !only) return null;
        const askBranch = a === 'approve' && ok && !!noBranch;
        const missing = askBranch && !branch.trim();
        return (
          <span key={a} className="inline-flex items-center gap-2">
            {askBranch && <Input value={branch} onChange={e => setBranch(e.target.value)} placeholder={t('Branch of this work (none recorded)')} aria-label={t('Branch of this work (none recorded)')} className="w-56 font-mono text-[13px]" />}
            <Tip text={ok ? (missing ? t('This order has no branch recorded: name it first so the merge can be checked.') : undefined) : unavailable?.[a]}>
              <span>
                <Button size={size} variant={a === 'approve' ? 'success' : a === 'cancel' ? 'ghost' : 'outline'} disabled={!ok || missing} onClick={() => setOpen(a)}>{actionLabel(a)}</Button>
              </span>
            </Tip>
          </span>
        );
      })}
      {open && <ActionDialog project={project} tag={tag} action={open} phases={phases} open onOpenChange={o => !o && setOpen(null)} initialText={initialText?.[open]} context={context} branch={branch} noBranch={noBranch} />}
    </>
  );
}
