import { OrderBodyEditor } from '@/components/OrderBodyEditor';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/misc';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { ErrorBox, PageHeader } from '@/components/common';
import { errorText, useNewOrder, useProjectId, useProjects, useRoles, useWorkers } from '@/lib/queries';
import { t } from '@/i18n';

const TAG = /^[A-Za-z][A-Za-z0-9]*$/;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="grid gap-1"><Label>{label}</Label>{children}{hint && <div className="text-xs text-muted-foreground">{hint}</div>}</div>;
}

export function NewOrderPage() {
  const project = useProjectId();
  const navigate = useNavigate();
  const info = useProjects().data?.find(p => p.id === project);
  const workers = useWorkers(project).data?.workers ?? [];
  const roles = useRoles(project);
  const create = useNewOrder(project);
  const [f, setF] = useState({ tag: '', title: '', kind: '', role: '', worker: '', needs: '', base_ref: '', mandate: '', body: '', queue: false });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(s => ({ ...s, [k]: v }));
  const tag = f.tag.trim();
  const valid = TAG.test(tag) && f.title.trim().length > 0;
  const resolved = roles.data?.roles.find(r => f.role ? r.id === f.role : r.kinds?.includes(f.kind.trim()))
    ?? (!f.role ? roles.data?.roles.find(r => r.default || r.id === 'default') : undefined);
  const candidate = f.worker || resolved?.candidates.find(c => c.verdict === 'chosen')?.worker;
  const missing = resolved?.requires?.filter(c => !workers.find(w => w.id === f.worker)?.capabilities.includes(c)) ?? [];

  const submit = () => create.mutate(
    {
      tag, title: f.title.trim(), kind: f.kind.trim() || undefined, role: f.role || undefined, worker: f.worker || undefined,
      needs: f.needs.split(/[\s,]+/).filter(Boolean), mandate: f.mandate.trim() ? { quote: f.mandate.trim() } : undefined,
      base_ref: f.base_ref.trim() || undefined, body: f.body.trim() || undefined, queue: f.queue,
    },
    {
      onSuccess: r => {
        toast.success(t('Order {tag} created', { tag: r.order.tag }) + (r.file ? ` · ${r.file}` : ''));
        navigate(`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(r.order.tag)}`);
      },
    },
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title={t('New order')}>{info?.name}</PageHeader>
      <Card><CardContent className="grid gap-4">
        <div className="grid items-start gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Field label={t('Tag')} hint={f.tag && !TAG.test(tag) ? t('Letters and digits, starting with a letter') : undefined}><Input value={f.tag} onChange={e => set('tag', e.target.value)} placeholder="MV5" className="font-mono" autoFocus /></Field>
          <Field label={t('Title')}><Input value={f.title} onChange={e => set('title', e.target.value)} placeholder={t('One line: what is done when it is finished')} /></Field>
        </div>
        <Field label={t('Route')}><Select value={f.role} onChange={e => set('role', e.target.value)}><option value="">{t('From kind')}</option>{roles.data?.roles.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}</Select>{roles.isError && <ErrorBox error={roles.error} />}</Field>
        <div className="grid items-start gap-4 sm:grid-cols-3">
          <Field label={t('Kind')}><Input value={f.kind} onChange={e => set('kind', e.target.value)} placeholder="gameplay" /></Field>
          <Field label={t('Worker')}>
            <Select value={f.worker} onChange={e => set('worker', e.target.value)}>
              <option value="">{t('Let the tick choose')}</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}
            </Select>
          </Field>
          <Field label="base_ref" hint={t('Local branch the worktree starts from')}><Input value={f.base_ref} onChange={e => set('base_ref', e.target.value)} placeholder="main" className="font-mono" /></Field>
        </div>
        {roles.data && <div className="rounded-md border p-3 text-sm">
          <p>{t('Route')}: <strong>{resolved?.id || t('none')}</strong> → {t('Worker')}: <strong>{candidate || t('No qualifying worker right now')}</strong></p>
          {!resolved && <p className="text-destructive">{t('No role: choose a role or configure a default.')}</p>}
          {f.worker && missing.length > 0 && <p className="text-warning">{t('Explicit worker is missing capabilities')}: {missing.join(', ')}</p>}
          {!f.role && !f.kind.trim() && <p className="text-xs text-muted-foreground">{t('Preview uses the default role; classification may change it when the order is created.')}</p>}
        </div>}
        <Field label={t('Needs')} hint={t('Tags that must be merged first, separated by commas')}><Input value={f.needs} onChange={e => set('needs', e.target.value)} placeholder="MV3, TR2" className="font-mono" /></Field>
        <Field label={t('Mandate')} hint={t('Why it may be done, in your words')}><Textarea value={f.mandate} onChange={e => set('mandate', e.target.value)} className="min-h-16" /></Field>
        <Field label={t('Work order text (optional)')} hint={info?.workOrdersDir ? t('Written to {dir}/{tag}-<slug>.md; an existing file is never replaced.', { dir: info.workOrdersDir, tag: tag || '<TAG>' }) : undefined}>
          <OrderBodyEditor value={f.body} onChange={body => set('body', body)} />
        </Field>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.queue} onCheckedChange={v => set('queue', v === true)} />{t('Queue it right away')}</label>
        {info && !info.tableWriteBack && <div className="text-xs text-muted-foreground">{t('This project does not write a dispatch table; the order only goes into the state.')}</div>}
        {create.isError && <ErrorBox error={errorText(create.error)} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>{t('Back')}</Button>
          <Button disabled={!valid || create.isPending} onClick={submit}>{create.isPending ? t('Working…') : t('Create order')}</Button>
        </div>
      </CardContent></Card>
    </div>
  );
}
