import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, ApiFailure } from '@/lib/api';
import { buildChange, formOf, idOf, schema, type ChangeSet, type DesignKind, type DesignResult, type Entity } from '@/lib/design';
import { designKey } from '@/lib/design-queries';
import { t } from '@/i18n';

export function ConflictView({ before, after }: { before: unknown; after: unknown }) {
  return <div role="alert" className="rounded-lg border border-warning bg-warning/10 p-3">
    <p className="font-semibold">{t('This entity changed while you were editing.')}</p>
    <p className="mb-2 text-sm">{t('Compare both versions, then reload before saving again.')}</p>
    <div className="grid gap-3 sm:grid-cols-2">{[[t('Your proposed version'), before], [t('Current saved version'), after]].map(([label, value], i) => <div key={i}><h3 className="mb-1 text-xs font-semibold">{String(label)}</h3><pre className="max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre></div>)}</div>
  </div>;
}

export function DesignEdit({ project, kind, row: initial, system, retire = false, onClose }: { project: string; kind: DesignKind; row?: Entity; system?: string; retire?: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [row, setRow] = useState(initial);
  const [form, setForm] = useState(() => formOf(kind, initial, system));
  const [decision, setDecision] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<{ changeset: ChangeSet; result: DesignResult }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ proposed: unknown; current: Entity }>();
  const [exportError, setExportError] = useState('');
  const reset = () => { setChecked(undefined); setProblems({}); setError(''); };
  const save = async (apply: boolean) => {
    const built = buildChange(kind, form, row, retire, decision);
    setProblems(built.problems);
    if (!built.changeset) return;
    const changeset = apply ? checked?.changeset : built.changeset;
    if (!changeset) return;
    setBusy(true); setError('');
    try {
      const result = await api.designApply(project, changeset, !apply);
      if (!apply) setChecked({ changeset, result });
      else {
        await client.invalidateQueries({ queryKey: designKey(project) });
        if (result.export_error) { setExportError(result.export_error); setChecked(undefined); }
        else onClose();
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        // IDs can overlap between kinds (for example, a glossary term and a system code).
        const current = await api.design(project).then(data => data[kind].find(entity => idOf(kind, entity) === changeset.changes[0].id)).catch(() => undefined);
        if (current) setConflict({ proposed: { ...row, ...changeset.changes[0].fields }, current });
        await client.invalidateQueries({ queryKey: designKey(project) });
      }
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (e instanceof ApiFailure && e.details?.length) setProblems(Object.fromEntries(e.details.map(p => [p.field ?? '_', p.message])));
      else {
        const field = schema[kind].find(f => message.includes(f.key));
        if (field) setProblems({ [field.key]: message });
      }
      setChecked(undefined);
    } finally { setBusy(false); }
  };
  const reload = () => {
    if (!conflict) return;
    setRow(conflict.current); setForm(formOf(kind, conflict.current, system)); setConflict(undefined); reset();
  };
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}><DialogContent className="top-[4vh] max-h-[92vh] w-[min(96vw,64rem)]">
    <DialogTitle>{retire ? t('Retire rule') : row ? t('Edit {id}', { id: idOf(kind, row) }) : t('New design entity')}</DialogTitle>
    <DialogDescription>{t('Check the change first, review validation, then apply it. Parameter values come from gameplay files.')}</DialogDescription>
    {conflict ? <><ConflictView before={conflict.proposed} after={conflict.current} /><DialogFooter><Button onClick={reload}>{t('Reload current version')}</Button></DialogFooter></> : exportError ? <div role="status"><p>{t('Saved, but the backup export failed. Do not apply again.')}</p><p className="text-sm text-destructive">{exportError}</p><Button onClick={onClose}>{t('Close')}</Button></div> : <>
      <div className="grid gap-3 sm:grid-cols-2">{schema[kind].map(field => {
        const identity = ['id', 'code', 'term'].includes(field.key) || field.key === 'system' || kind === 'decision_link';
        const disabled = busy || !!row && identity;
        const props = { id: `design-${field.key}`, value: form[field.key], disabled, 'aria-invalid': !!problems[field.key], 'aria-describedby': problems[field.key] ? `problem-${field.key}` : undefined, onChange: (e: { target: { value: string } }) => { setForm(f => ({ ...f, [field.key]: e.target.value })); reset(); } };
        return <div key={field.key} className="grid content-start gap-1"><Label htmlFor={props.id}>{t(field.label)}{field.nullable || field.optional ? ` (${t('Optional')})` : ''}</Label>
          {field.choices ? <Select {...props}>{field.choices.map(v => <option key={v} value={v}>{t(v)}</option>)}</Select> : ['json', 'list', 'long'].includes(field.type ?? '') ? <Textarea {...props} className={field.type === 'json' ? 'min-h-24 font-mono text-xs' : 'min-h-16'} /> : <Input {...props} type={field.type === 'number' ? 'number' : 'text'} step="any" />}
          {field.type === 'list' && <span className="text-[11px] text-muted-foreground">{t('One item per line.')}</span>}
          {field.type === 'json' && <span className="text-[11px] text-muted-foreground">{field.key === 'measure' ? t('JSON object with argv, timeout_minutes, value and when; null disables measurement.') : field.key === 'location' ? t('JSON object with file and pointer.') : field.key === 'criteria' ? t('JSON list of {target: id} or {text: criterion}.') : field.key === 'sources' || field.key === 'evidence' ? t('JSON list of {kind, ref} objects.') : t('JSON list.')}</span>}
          {problems[field.key] && <p id={`problem-${field.key}`} className="text-xs text-destructive">{t(problems[field.key])}</p>}
        </div>;
      })}</div>
      {(kind === 'rule' || kind === 'param') && <div className="grid gap-1"><Label htmlFor="design-decision">{t('Decision id (optional)')}</Label><Input id="design-decision" value={decision} disabled={busy} onChange={e => { setDecision(e.target.value); reset(); }} /></div>}
      <div aria-live="polite">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{checked && <div className="rounded-lg border border-success/40 bg-success/10 p-3 text-sm"><p>{t('Validation passed. Review the change before applying.')}</p>{checked.result.warnings.map((w, i) => <p key={i} className="text-warning">{w.entity}: {w.message}</p>)}<details className="mt-2"><summary className="cursor-pointer">{t('Change set')}</summary><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(checked.changeset, null, 2)}</pre></details></div>}</div>
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t('Back')}</Button><Button variant="outline" disabled={busy} onClick={() => void save(false)}>{busy ? t('Working…') : t('Check change')}</Button><Button disabled={busy || !checked} onClick={() => void save(true)}>{t('Apply change')}</Button></DialogFooter>
    </>}
  </DialogContent></Dialog>;
}
