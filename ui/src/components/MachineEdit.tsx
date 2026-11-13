import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { Machine } from '../../../src/machines/config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/misc';
import { ErrorBox } from '@/components/common';
import { CONNECTION_HINTS } from '@/components/MachineAdd';
import type { MachineEditResult } from '@/lib/api';
import { machineForm, machineSet, sshSet, type CheckKind, type MachineForm } from '@/lib/machine-edit';
import { errorText, machineCalls, useMachineSshHost } from '@/lib/queries';
import { t } from '@/i18n';

function Block({ title, text }: { title: string; text: string }) {
  return <div className="grid gap-1"><span className="text-xs text-muted-foreground">{title}</span>
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs leading-5 whitespace-pre">{text}</pre></div>;
}

/** Edits a machine of the registry and, for an SSH machine, the address of its alias in the SSH config of this computer. */
export function EditMachineDialog({ project, machine, open, onOpenChange }: { project: string; machine: Machine; open: boolean; onOpenChange: (o: boolean) => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState<MachineForm>(() => machineForm(machine));
  const [address, setAddress] = useState({ hostname: '', user: '', port: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<MachineEditResult>();
  const [result, setResult] = useState<MachineEditResult>();
  const originalAlias = 'ssh' in machine.connect ? machine.connect.ssh : undefined;
  const alias = form.local ? undefined : form.alias.trim() || undefined;
  const host = useMachineSshHost(project, open ? alias : undefined);

  useEffect(() => { if (open) { setForm(machineForm(machine)); setError(undefined); setPreview(undefined); setResult(undefined); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = host.data?.address;
    setAddress({ hostname: a?.hostname ?? '', user: a?.user ?? '', port: a?.port === undefined ? '' : String(a.port) });
  }, [host.data]);

  const set = useMemo(() => machineSet(machine, form), [machine, form]);
  const ssh = useMemo(() => host.data?.found && !host.data.problems.length ? sshSet(host.data.address, address) : undefined, [host.data, address]);
  const nothing = !Object.keys(set).length && !ssh;
  const patch = (p: Partial<MachineForm>) => { setForm(f => ({ ...f, ...p })); setPreview(undefined); };

  const send = async (dryRun: boolean) => {
    setBusy(true); setError(undefined);
    try {
      const r = await machineCalls.edit(project, { id: machine.id, ...(Object.keys(set).length ? { set } : {}), ...(ssh ? { ssh } : {}), dryRun });
      if (dryRun) setPreview(r);
      else {
        setResult(r); setPreview(undefined);
        toast.success(t('{id} updated', { id: machine.id }));
        void client.invalidateQueries({ queryKey: ['machines', project] });
        void client.invalidateQueries({ queryKey: ['machine-ssh-host', project] });
      }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const text = (label: string, key: keyof MachineForm, props: { mono?: boolean; placeholder?: string; numeric?: boolean } = {}) =>
    <div className="grid gap-1"><Label>{label}</Label><Input value={form[key] as string} onChange={e => patch({ [key]: e.target.value } as Partial<MachineForm>)} className={props.mono ? 'font-mono' : ''} placeholder={props.placeholder} inputMode={props.numeric ? 'decimal' : undefined} /></div>;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="w-[min(94vw,48rem)] max-h-[90vh] overflow-y-auto">
      <DialogTitle>{t('Edit {id}', { id: machine.id })}</DialogTitle>
      <DialogDescription>{t('Changes the registry entry and, for a machine reached over SSH, the address of its alias in the SSH config of this computer. Both files are backed up first; key files are never read or changed.')}</DialogDescription>

      {result ? <div className="grid gap-3 text-sm">
        <p>{result.changed.length ? t('Registry: changed {fields}.', { fields: result.changed.join(', ') }) : t('Registry: unchanged.')}</p>
        {result.ssh && <Block title={result.ssh.changed.length ? t('{file}: Host block now', { file: result.ssh.file }) : t('{file}: unchanged', { file: result.ssh.file })} text={result.ssh.after} />}
        {result.connection && <div className="grid gap-1 rounded-md border p-3">
          <div className="flex items-center gap-2"><Badge tone={result.connection.ok ? 'success' : 'danger'}>{result.connection.ok ? t('Connected') : t('Not connected')}</Badge>
            {result.connection.remoteName && <span className="font-mono text-xs">{result.connection.remoteName}</span>}<span className="text-xs text-muted-foreground">{result.connection.seconds} s</span></div>
          {!result.connection.ok && <p>{t(CONNECTION_HINTS[result.connection.category], { alias: alias ?? '' })}</p>}
          {result.machine?.latest && (result.machine.latest.error ? <p className="text-destructive">{t('Connected, but the health probe failed. Check that the operating system chosen in the first step is right, and that PowerShell (Windows) or sh, awk and df (Linux, macOS) are available.')}</p>
            : <p className="text-muted-foreground">{t('Free / total memory')}: {result.machine.latest.free_mem_gb?.toFixed(1)} / {result.machine.latest.total_mem_gb?.toFixed(1)} GB · {t('Disks')}: {result.machine.latest.disks.length}</p>)}
        </div>}
        {[result.backup, result.ssh?.backup].filter(Boolean).map(b => <p key={b} className="text-xs text-muted-foreground">{t('Backup: {file}', { file: b! })}</p>)}
      </div> : <div className="grid gap-4">
        <section className="grid gap-2 sm:grid-cols-2">
          {text(t('Name'), 'name')}
          <div className="grid gap-1"><Label>{t('Operating system')}</Label>
            <Select value={form.os} onChange={e => patch({ os: e.target.value as Machine['os'] })}><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></Select></div>
          <div className="grid gap-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!form.local} onChange={() => patch({ local: false, alias: form.alias || originalAlias || machine.id })} />{t('Another machine on the network (SSH)')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={form.local} onChange={() => patch({ local: true })} />{t('This computer (the one running alba)')}</label>
          </div>
        </section>

        {!form.local && <section className="grid gap-2 rounded-md border p-3">
          <h3 className="text-sm font-semibold">{t('SSH address')}</h3>
          {text(t('Alias'), 'alias', { mono: true })}
          {host.isError && <ErrorBox error={errorText(host.error)} />}
          {host.data && (host.data.found
            ? <Block title={t('{file}, line {line}: the block alba would change', { file: host.data.file, line: host.data.line ?? 0 })} text={host.data.block ?? ''} />
            : null)}
          {host.data?.problems.map(p => <p key={p} className="text-sm text-warning">{p}</p>)}
          {host.data?.found && !host.data.problems.length && <div className="grid gap-2 sm:grid-cols-3">
            <div className="grid gap-1"><Label>{t('IP address or host name')}</Label><Input value={address.hostname} onChange={e => { setAddress(a => ({ ...a, hostname: e.target.value })); setPreview(undefined); }} className="font-mono" placeholder="192.0.2.20" /></div>
            <div className="grid gap-1"><Label>{t('Login name on that machine')}</Label><Input value={address.user} onChange={e => { setAddress(a => ({ ...a, user: e.target.value })); setPreview(undefined); }} className="font-mono" /></div>
            <div className="grid gap-1"><Label>{t('Port')}</Label><Input value={address.port} onChange={e => { setAddress(a => ({ ...a, port: e.target.value })); setPreview(undefined); }} className="font-mono" placeholder="22" /></div>
          </div>}
          {host.data?.found && <p className="text-xs text-muted-foreground">{t('Only the HostName, User and Port lines of this block change; the key file, other hosts, Match and Include lines stay as they are. After saving, alba tests the connection and probes the machine.')}</p>}
        </section>}

        <section className="grid gap-2 sm:grid-cols-3">
          {text(t('Machine roles'), 'roles', { placeholder: 'sim, package, gpu-qa' })}
          {text(t('Slots'), 'slots', { numeric: true })}
          {text(t('Minimum free memory (GB)'), 'minFree', { numeric: true })}
          {text(t('Memory (GB)'), 'ram', { numeric: true })}
          {text('CPU', 'cpu')}
          {text('GPU', 'gpu')}
          <label className="flex items-center gap-2 self-end pb-1 text-sm"><Checkbox checked={form.timing} onCheckedChange={v => patch({ timing: v === true })} />{t('Timing allowed')}</label>
        </section>
        {text(t('Notes'), 'notes')}
        <section className="grid gap-2 sm:grid-cols-2">
          {text(t('Workspace (remote workers)'), 'workspace', { mono: true, placeholder: form.os === 'windows' ? '<drive>:/alba' : '/data/alba' })}
          <div className="grid gap-1"><Label>{t('Repositories (project: bare repository path, one per line)')}</Label>
            <Textarea rows={2} value={form.repos} onChange={e => patch({ repos: e.target.value })} className="font-mono text-xs" /></div>
        </section>
        <section className="grid gap-2"><div className="flex items-center justify-between"><Label>{t('Services')}</Label>
          <Button size="sm" variant="ghost" onClick={() => patch({ services: [...form.services, { id: '', kind: 'process', value: '', hint: '' }] })}><Plus className="size-3.5" />{t('Add a service')}</Button></div>
          {form.services.map((s, i) => <div key={i} className="grid gap-1 rounded-md border p-2 sm:grid-cols-[8rem_7rem_1fr_auto]">
            <Input value={s.id} onChange={e => patch({ services: form.services.map((x, j) => j === i ? { ...x, id: e.target.value } : x) })} placeholder="id" className="font-mono" />
            <Select value={s.kind} onChange={e => patch({ services: form.services.map((x, j) => j === i ? { ...x, kind: e.target.value as CheckKind } : x) })}><option value="process">process</option><option value="tcp">tcp</option><option value="http">http</option><option value="command">command</option></Select>
            <Input value={s.value} onChange={e => patch({ services: form.services.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} className="font-mono" />
            <Button size="icon" variant="ghost" aria-label={t('Remove')} onClick={() => patch({ services: form.services.filter((_, j) => j !== i) })}><X className="size-4" /></Button>
            <Input className="sm:col-span-4" value={s.hint} onChange={e => patch({ services: form.services.map((x, j) => j === i ? { ...x, hint: e.target.value } : x) })} placeholder={t('Start hint shown when it is down (optional)')} />
          </div>)}
        </section>
        {preview && <div className="grid gap-2 rounded-md border border-dashed p-3 text-sm">
          <p>{preview.changed.length ? t('Registry: would change {fields}.', { fields: preview.changed.join(', ') }) : t('Registry: unchanged.')}</p>
          {preview.ssh && <div className="grid gap-2 sm:grid-cols-2"><Block title={t('Before')} text={preview.ssh.before} /><Block title={t('After')} text={preview.ssh.after} /></div>}
          <p className="text-xs text-muted-foreground">{t('Nothing was written yet.')}</p>
        </div>}
        {error && <ErrorBox error={error} />}
      </div>}

      <DialogFooter>
        {result ? <Button onClick={() => onOpenChange(false)}>{t('Close')}</Button> : <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
          <Button variant="outline" disabled={busy || nothing} onClick={() => void send(true)}>{t('Preview')}</Button>
          <Button disabled={busy || nothing} onClick={() => void send(false)}>{busy ? t('Working…') : ssh ? t('Save and test the connection') : t('Save')}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
