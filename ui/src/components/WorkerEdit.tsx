import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Worker } from '@api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorBox } from '@/components/common';
import { ApiFailure } from '@/lib/api';
import { errorText, useEditWorker, useNewWorker, useRemoveWorker, useWorkerYaml } from '@/lib/queries';
import { changesOf, formOf, otherProblems, problemsFor, type DisabledRow, type FieldProblem, type WorkerForm } from '@/lib/workers';
import { t } from '@/i18n';

const detailsOf = (e: unknown): FieldProblem[] | undefined => (e instanceof ApiFailure ? e.details : undefined);

/** What the server found wrong, under the field it belongs to. */
function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="grid gap-0.5 text-xs text-destructive">{list.map((m, i) => <div key={i}>{m}</div>)}</div>;
}

const FORM_FIELDS = ['notes', 'capabilities', 'cost', 'concurrency', 'daily_runs', 'enabled', 'aliases', 'daily_cap_usd', 'model_family', 'on_limit', 'rotate_paid', 'disabled_when'];

function FieldsForm({ form, setForm, details }: { form: WorkerForm; setForm: (f: WorkerForm) => void; kinds: string[]; details?: FieldProblem[] }) {
  const set = <K extends keyof WorkerForm>(k: K, v: WorkerForm[K]) => setForm({ ...form, [k]: v });
  const setRule = (i: number, patch: Partial<DisabledRow>) => set('disabledWhen', form.disabledWhen.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label>{t('Supply notes')}</Label>
        <Textarea value={form.notes} onChange={e => set('notes', e.target.value)} className="min-h-16" placeholder={t('Limits and supply quirks')} />
        <Problems list={problemsFor(details, 'notes')} />
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <div className="grid gap-1"><Label>{t('Cost')}</Label>
          <Select value={form.cost} onChange={e => set('cost', e.target.value as WorkerForm['cost'])}><option value="included">{t('included in a plan')}</option><option value="paid">{t('paid')}</option></Select>
          <Problems list={problemsFor(details, 'cost')} /></div>
        <div className="grid gap-1"><Label>{t('Runs at once')}</Label><Input inputMode="numeric" value={form.concurrency} onChange={e => set('concurrency', e.target.value)} className="tabular-nums" aria-invalid={problemsFor(details, 'concurrency').length > 0} /><Problems list={problemsFor(details, 'concurrency')} /></div>
        <div className="grid gap-1"><Label>{t('Runs a day')}</Label><Input inputMode="numeric" value={form.dailyRuns} onChange={e => set('dailyRuns', e.target.value)} placeholder={t('no limit')} className="tabular-nums" /><Problems list={problemsFor(details, 'daily_runs')} /></div>
        <div className="grid gap-1"><Label>{t('Spend cap a day (USD)')}</Label><Input inputMode="decimal" value={form.dailyCapUsd} onChange={e => set('dailyCapUsd', e.target.value)} placeholder={t('no cap')} className="tabular-nums" /><Problems list={problemsFor(details, 'daily_cap_usd')} /></div>
      </div>

      <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.enabled} onCheckedChange={v => set('enabled', v === true)} />{t('Turned on (a worker that is off is never chosen)')}</label>

      <div className="grid gap-1">
        <Label>{t('When its usage runs out')}</Label>
        <Select value={form.onLimit} onChange={e => set('onLimit', e.target.value as WorkerForm['onLimit'])}><option value="wait">{t('wait for the window to reset')}</option><option value="rotate">{t('hand the order to another worker')}</option></Select>
        <span className="text-[11px] text-muted-foreground">{t('Handing over: the next qualifying worker for the same role continues from a handover file. A paid worker is used only when this box is ticked, the order may spend, or the one that ran out was paid. If that worker is busy, the order waits.')}</span>
        <label className="mt-1 flex items-center gap-2 text-sm"><Checkbox checked={form.rotatePaid} onCheckedChange={v => set('rotatePaid', v === true)} />{t('May hand over to a paid worker')}</label>
        <Problems list={problemsFor(details, 'on_limit')} />
        <Problems list={problemsFor(details, 'rotate_paid')} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1"><Label>{t('Names it answers to')}</Label><Input value={form.aliases} onChange={e => set('aliases', e.target.value)} placeholder={t('separated by commas')} /><span className="text-[11px] text-muted-foreground">{t('Words in an order’s worker text that mean this worker.')}</span><Problems list={problemsFor(details, 'aliases')} /></div>
        <div className="grid gap-1"><Label>{t('Model')}</Label><Input value={form.modelFamily} onChange={e => set('modelFamily', e.target.value)} placeholder="grok-4.7" className="font-mono" /><span className="text-[11px] text-muted-foreground">{t('Workers with the same model are shown as the same model in a different shell.')}</span><Problems list={problemsFor(details, 'model_family')} /></div>
      </div>

      <div className="grid gap-1.5">
        <Label>{t('Capabilities')}</Label>
        <Input value={form.capabilities} onChange={e => set('capabilities', e.target.value)} placeholder="shell, edit, git, mcp" />
        <Problems list={problemsFor(details, 'capabilities')} />
      </div>

      <div className="grid gap-1.5">
        <Label>{t('Turn it off when')}</Label>
        {form.disabledWhen.map((r, i) => (
          <div key={i} className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={r.kind} onChange={e => setRule(i, { kind: e.target.value as DisabledRow['kind'] })} className="w-44"><option value="window">{t('a window is used up to')}</option><option value="balance">{t('the balance drops by')}</option></Select>
              {r.kind === 'window'
                ? <><Input value={r.window} onChange={e => setRule(i, { window: e.target.value })} placeholder="*" className="w-32" aria-label={t('Window name (* for any)')} /><Input inputMode="decimal" value={r.at} onChange={e => setRule(i, { at: e.target.value })} className="w-20 tabular-nums" aria-label={t('Percent')} /><span className="text-sm text-muted-foreground">%</span></>
                : <><Input inputMode="decimal" value={r.drop} onChange={e => setRule(i, { drop: e.target.value })} className="w-24 tabular-nums" aria-label={t('Amount')} /><span className="text-sm text-muted-foreground">{t('since the last reading')}</span></>}
              <Button type="button" variant="ghost" size="icon" aria-label={t('Remove')} onClick={() => set('disabledWhen', form.disabledWhen.filter((_, j) => j !== i))}><X /></Button>
            </div>
            <Problems list={problemsFor(details, `disabled_when[${i}]`)} />
          </div>
        ))}
        <div><Button type="button" variant="outline" size="sm" onClick={() => set('disabledWhen', [...form.disabledWhen, { kind: 'window', window: '*', at: '95', drop: '' }])}><Plus />{t('Add a rule')}</Button></div>
        <Problems list={details?.filter(d => d.field === 'disabled_when').map(d => d.message) ?? []} />
      </div>
    </div>
  );
}

/** The worker's own YAML, with its comments: for what the fields do not cover (the launch template, quota source, price). Checked first, then written. */
function YamlEditor({ project, worker, onDone }: { project: string; worker: Worker; onDone: () => void }) {
  const yaml = useWorkerYaml(project, worker.id, true);
  const edit = useEditWorker(project);
  const [text, setText] = useState<string | undefined>();
  useEffect(() => { if (yaml.data && text === undefined) setText(yaml.data.yaml); }, [yaml.data, text]);
  const [checked, setChecked] = useState<string | undefined>();
  if (yaml.isError) return <ErrorBox error={yaml.error} />;
  if (!yaml.data || text === undefined) return <Skeleton className="h-64" />;
  const details = detailsOf(edit.error);
  const run = (dryRun: boolean) => edit.mutate({ id: worker.id, yaml: text, dryRun }, {
    onSuccess: res => { if (dryRun) setChecked(res.changed.length ? t('Valid. It would change: {fields}', { fields: res.changed.join(', ') }) : t('Valid. Nothing would change.')); else onDone(); },
  });
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t('The worker as written in the workers file, comments included. Keys do not go in the launch environment: use a command that reads the key from a file.')}</p>
      <Textarea value={text} onChange={e => { setText(e.target.value); setChecked(undefined); edit.reset(); }} spellCheck={false} className="min-h-72 font-mono text-xs leading-5 whitespace-pre" aria-label={t('The worker as YAML')} aria-invalid={edit.isError} />
      {checked && <div className="rounded-md bg-success/12 px-2.5 py-1.5 text-xs">{checked}</div>}
      {edit.isError && (
        <div className="grid gap-1">
          <ErrorBox error={errorText(edit.error)} />
          {(details ?? []).length > 1 && <div className="grid gap-0.5 text-xs text-destructive">{details!.map((d, i) => <div key={i}>{d.field ? <span className="font-mono">{d.field}: </span> : null}{d.message}</div>)}</div>}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" disabled={edit.isPending} onClick={() => run(true)}>{t('Check')}</Button>
        <Button disabled={edit.isPending || text === yaml.data.yaml} onClick={() => run(false)}>{edit.isPending ? t('Working…') : t('Save')}</Button>
      </DialogFooter>
    </div>
  );
}

/** Edit one worker: the usual fields, or the whole worker as YAML. The server checks the result as the whole file before it writes anything. */
export function WorkerEditDialog({ project, worker, kinds, open, onOpenChange }: { project: string; worker: Worker; kinds: string[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const edit = useEditWorker(project);
  const initial = useMemo(() => formOf(worker), [worker]);
  const [form, setForm] = useState<WorkerForm>(initial);
  const [local, setLocal] = useState<FieldProblem[] | undefined>();
  const [tab, setTab] = useState('fields');
  useEffect(() => { if (open) { setForm(initial); setLocal(undefined); edit.reset(); setTab('fields'); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const details = [...(local ?? []), ...(detailsOf(edit.error) ?? [])];
  const save = () => {
    const r = changesOf(initial, form);
    if (!r.ok) { setLocal(r.problems); return; }
    setLocal(undefined);
    if (Object.keys(r.set).length === 0) { onOpenChange(false); return; }
    edit.mutate({ id: worker.id, set: r.set }, { onSuccess: () => onOpenChange(false) });
  };
  const stray = [...otherProblems(details, FORM_FIELDS)];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,48rem)] top-[6vh] max-h-[88vh]">
        <DialogTitle>{t('Edit {id}', { id: worker.id })}</DialogTitle>
        <DialogDescription>{t('The change is written into the workers file with its comments kept; the old file is copied next to it first.')}</DialogDescription>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="fields">{t('Fields')}</TabsTrigger>
            <TabsTrigger value="yaml">{t('Advanced (YAML)')}</TabsTrigger>
          </TabsList>
          <TabsContent value="fields">
            <FieldsForm form={form} setForm={setForm} kinds={kinds} details={details} />
            {edit.isError && stray.length === 0 && details.length === 0 && <div className="mt-3"><ErrorBox error={errorText(edit.error)} /></div>}
            {stray.length > 0 && <div className="mt-3"><ErrorBox error={stray.join(' ')} /></div>}
            <DialogFooter className="mt-4">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
              <Button disabled={edit.isPending} onClick={save}>{edit.isPending ? t('Working…') : t('Save')}</Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="yaml">
            {tab === 'yaml' && <YamlEditor project={project} worker={worker} onDone={() => onOpenChange(false)} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Take a worker out of the workers file, after a confirmation. The server refuses while a run, a pinned order or a route still uses it, and says which. */
export function RemoveWorkerDialog({ project, id, open, onOpenChange }: { project: string; id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const remove = useRemoveWorker(project);
  useEffect(() => { if (open) remove.reset(); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t('Remove {id}?', { id })}</DialogTitle>
        <DialogDescription>{t('The worker is taken out of the workers file; the old file is copied next to it first. A worker that a run, a pinned order or a route still uses cannot be removed.')}</DialogDescription>
        {remove.isError && <ErrorBox error={errorText(remove.error)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(id, { onSuccess: () => onOpenChange(false) })}>{remove.isPending ? t('Working…') : t('Remove the worker')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TEMPLATE = 'engine: codex-cli\ncapabilities: [shell, edit, git]\nnotes: Quota and supply limits\nlaunch:\n  program: codex\n  args: ["exec", "{prompt_file}"]\n';

/** A new worker: a copy of an existing one under a new id (the usual way), or written from YAML. */
export function NewWorkerDialog({ project, workers, copyFrom, open, onOpenChange }: { project: string; workers: Worker[]; copyFrom?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const add = useNewWorker(project);
  const [id, setId] = useState('');
  const [from, setFrom] = useState(copyFrom ?? '');
  const [yaml, setYaml] = useState(TEMPLATE);
  useEffect(() => { if (open) { setId(''); setFrom(copyFrom ?? workers[0]?.id ?? ''); setYaml(TEMPLATE); add.reset(); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const details = detailsOf(add.error);
  const copying = from !== '';
  const ready = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && (copying || yaml.trim() !== '');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,40rem)]">
        <DialogTitle>{copyFrom ? t('Copy {id}', { id: copyFrom }) : t('New worker')}</DialogTitle>
        <DialogDescription>{t('The new worker goes into the workers file; a copy sits right after the one it was copied from, and everything but the id is the same until you edit it.')}</DialogDescription>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1"><Label>{t('New id')}</Label><Input autoFocus value={id} onChange={e => setId(e.target.value)} className="font-mono" placeholder="grok-cli-2" aria-invalid={id !== '' && !ready} /><Problems list={problemsFor(details, 'id')} /></div>
          <div className="grid gap-1"><Label>{t('Copy of')}</Label>
            <Select value={from} onChange={e => setFrom(e.target.value)}><option value="">{t('(none: write it as YAML)')}</option>{workers.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}</Select></div>
        </div>
        {!copying && (
          <div className="grid gap-1"><Label>{t('The worker as YAML')}</Label><Textarea value={yaml} onChange={e => setYaml(e.target.value)} spellCheck={false} className="min-h-52 font-mono text-xs leading-5 whitespace-pre" /></div>
        )}
        {add.isError && <ErrorBox error={errorText(add.error)} />}
        {(details ?? []).filter(d => d.field !== 'id').length > 1 && <div className="grid gap-0.5 text-xs text-destructive">{details!.filter(d => d.field !== 'id').map((d, i) => <div key={i}>{d.field ? <span className="font-mono">{d.field}: </span> : null}{d.message}</div>)}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
          <Button disabled={!ready || add.isPending} onClick={() => add.mutate(copying ? { id, copyFrom: from } : { id, yaml }, { onSuccess: () => onOpenChange(false) })}>{add.isPending ? t('Working…') : t('Add the worker')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

