import { useState } from 'react';
import type { OrderDetail } from '@api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { ErrorBox } from '@/components/common';
import { ChipsInput, Choice, Field } from '@/components/EditFields';
import { OrderBodyEditor } from '@/components/OrderBodyEditor';
import type { OrderFieldsEdit } from '@/lib/api';
import { numberField, same } from '@/lib/config-edit';
import { errorText, useEditOrderBody, useEditOrderFields, useOrders, useResources, useSkills, useWorkers } from '@/lib/queries';
import { t } from '@/i18n';

type Order = OrderDetail['order'];

/** The form of an order's fields, as text and lists. */
export function formOfOrder(o: Order) {
  return {
    title: o.title, kind: o.kind, priority: o.priority === undefined ? '' : String(o.priority), worker: o.worker ?? '', heavy: o.heavy ?? '', condition: o.condition ?? '',
    needs: o.needs, tags: o.tags ?? [], skills: o.skills ?? [], uses: o.uses ?? [], tools: o.tools ?? [], review: o.review ?? 'auto', check: o.check ?? 'independent',
  };
}
export type OrderForm = ReturnType<typeof formOfOrder>;

/** Only the fields that changed, as `POST /api/orders/:tag/fields` takes them; or what is wrong with the form. */
export function orderFieldChanges(o: Order, form: OrderForm): { ok: true; fields: OrderFieldsEdit } | { ok: false; problem: string } {
  const was = formOfOrder(o);
  const fields: OrderFieldsEdit = {};
  if (!form.title.trim()) return { ok: false, problem: t('The title cannot be empty.') };
  if (!form.kind.trim()) return { ok: false, problem: t('The kind cannot be empty.') };
  const priority = numberField(form.priority);
  if (!priority.ok || (priority.value !== undefined && !Number.isInteger(priority.value))) return { ok: false, problem: t('The priority is a whole number.') };
  if (form.title.trim() !== was.title) fields.title = form.title.trim();
  if (form.kind.trim() !== was.kind) fields.kind = form.kind.trim();
  if (form.priority.trim() !== was.priority) fields.priority = priority.value ?? null;
  if (form.worker !== was.worker) fields.worker = form.worker || null;
  if (form.heavy.trim() !== was.heavy) fields.heavy = form.heavy.trim() || null;
  if (form.condition.trim() !== was.condition) fields.condition = form.condition.trim() || null;
  for (const key of ['needs', 'tags', 'skills', 'uses', 'tools'] as const) if (!same(form[key], was[key])) fields[key] = form[key];
  if (form.review !== was.review) fields.review = form.review;
  if (form.check !== was.check) fields.check = form.check;
  return { ok: true, fields };
}

/** The Definition card in edit mode: every field a person may change after the order is made, saved in one request. */
export function OrderDefinitionEdit({ project, order, onDone }: { project: string; order: Order; onDone: () => void }) {
  const [form, setForm] = useState(() => formOfOrder(order));
  const edit = useEditOrderFields(project, order.tag);
  const workers = useWorkers(project);
  const orders = useOrders(project);
  const resources = useResources(project);
  const skills = useSkills(project);
  const set = <K extends keyof OrderForm>(k: K, v: OrderForm[K]) => { setForm({ ...form, [k]: v }); edit.reset(); };
  const change = orderFieldChanges(order, form);
  const dirty = change.ok && Object.keys(change.fields).length > 0;
  const save = () => { if (change.ok) edit.mutate(change.fields, { onSuccess: onDone }); };
  const workerIds = (workers.data?.workers ?? []).map(w => w.id);
  return (
    <div className="grid gap-3">
      <Field label={t('Title')}><Input value={form.title} onChange={e => set('title', e.target.value)} aria-label={t('Title')} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('Kind')}><Input value={form.kind} onChange={e => set('kind', e.target.value)} aria-label={t('Kind')} className="font-mono" /></Field>
        <Field label={t('Priority')}><Input value={form.priority} onChange={e => set('priority', e.target.value)} inputMode="numeric" placeholder="0" aria-label={t('Priority')} className="tabular-nums" /></Field>
      </div>
      <Field label={t('Worker')}>
        <Select value={form.worker} onChange={e => set('worker', e.target.value)} aria-label={t('Worker')}>
          <option value="">{t('None: the route chooses')}</option>
          {[...new Set([...workerIds, ...(form.worker ? [form.worker] : [])])].map(id => <option key={id} value={id}>{id}</option>)}
        </Select>
      </Field>
      <Field label={t('Needs')}><ChipsInput label={t('Needs')} value={form.needs} options={(orders.data?.items ?? []).map(x => x.tag).filter(x => x !== order.tag)} onChange={v => set('needs', v)} /></Field>
      <Field label={t('Tags')}><ChipsInput label={t('Tags')} value={form.tags} onChange={v => set('tags', v)} /></Field>
      <Field label={t('Skills')}><ChipsInput label={t('Skills')} value={form.skills} options={(skills.data?.skills ?? []).map(s => s.name)} onChange={v => set('skills', v)} /></Field>
      <Field label={t('Uses')}><ChipsInput label={t('Uses')} value={form.uses} options={(resources.data?.resources ?? []).map(r => r.name)} onChange={v => set('uses', v)} /></Field>
      <Field label={t('Tools')}><ChipsInput label={t('Tools')} value={form.tools} onChange={v => set('tools', v)} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('Heavy class')}><Input value={form.heavy} onChange={e => set('heavy', e.target.value)} aria-label={t('Heavy class')} className="font-mono" /></Field>
        <Field label={t('Condition')}><Input value={form.condition} onChange={e => set('condition', e.target.value)} aria-label={t('Condition')} /></Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Field label={t('Review')}><Choice label={t('Review')} value={form.review} onChange={v => set('review', v)} options={[{ value: 'manual', label: t('a person reviews') }, { value: 'auto', label: t('automatic') }]} /></Field>
        <Field label={t('Independent check')}><Choice label={t('Independent check')} value={form.check} onChange={v => set('check', v)} options={[{ value: 'independent', label: t('run it') }, { value: 'none', label: t('skip it') }]} /></Field>
      </div>
      {!change.ok && <div className="text-xs text-destructive">{change.problem}</div>}
      {edit.isError && <ErrorBox error={errorText(edit.error)} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={edit.isPending} onClick={onDone}>{t('Cancel')}</Button>
        <Button size="sm" disabled={!dirty || edit.isPending} onClick={save}>{edit.isPending ? t('Working…') : t('Save')}</Button>
      </div>
    </div>
  );
}

/** The work-order text in an editor; saved only if the file is still what it was when the editor opened. */
export function OrderBodyDialog({ project, tag, file, open, onOpenChange }: { project: string; tag: string; file: { path: string; markdown: string }; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState(file.markdown);
  const edit = useEditOrderBody(project, tag);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6vh] max-h-[88vh] w-[min(96vw,56rem)]">
        <DialogTitle>{t('Edit the work order of {tag}', { tag })}</DialogTitle>
        <DialogDescription><span className="font-mono">{file.path}</span> · {t('If the file changes meanwhile (a producer or another person writes it), nothing is saved: reload and edit again.')}</DialogDescription>
        <OrderBodyEditor value={text} onChange={v => { setText(v); edit.reset(); }} />
        {edit.isError && <ErrorBox error={errorText(edit.error)} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Back')}</Button>
          <Button disabled={edit.isPending || !text.trim() || text === file.markdown} onClick={() => edit.mutate({ text, expected: file.markdown }, { onSuccess: () => onOpenChange(false) })}>{edit.isPending ? t('Working…') : t('Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
