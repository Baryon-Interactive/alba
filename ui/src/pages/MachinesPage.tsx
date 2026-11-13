import { useState } from 'react';
import { Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { MachineReading, MachineView } from '../../../src/machines/probe';
import { Button } from '@/components/ui/button';
import { AddMachineDialog } from '@/components/MachineAdd';
import { EditMachineDialog } from '@/components/MachineEdit';
import { CapabilitySummary, roleTitle } from '@/components/MachineCapabilities';
import { InstallDialog, MachineJobs } from '@/components/MachineInstall';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { EmptyState, ErrorBox, PageHeader } from '@/components/common';
import { useMachineChanges, useMachines, useOverview, useProjectId, useWorkers } from '@/lib/queries';
import { FleetMap } from '@/components/FleetMap';
import { nth } from '@/components/motion';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';

const gb = (n?: number) => n === undefined ? '—' : `${n.toFixed(1)} GB`;
function MemoryHistory({ history }: { history: MachineReading[] }) {
  const now = Date.now(), start = now - 86400000;
  const points = history.filter(p => Date.parse(p.at) >= start && p.free_mem_gb !== undefined);
  const max = Math.max(1, ...points.map(p => p.total_mem_gb ?? p.free_mem_gb!));
  return <figure aria-label={t('Free memory over 24 hours')}>
    <figcaption className="text-xs text-muted-foreground">{t('Free memory over 24 hours')}</figcaption>
    {points.length ? <svg data-memory-history viewBox="0 0 400 64" className="mt-2 h-16 w-full" role="img" aria-label={t('Free memory over 24 hours')}>
      <line x1="0" y1="62" x2="400" y2="62" stroke="var(--border)" />
      <polyline fill="none" stroke="var(--primary)" strokeWidth="2" points={points.map(p => `${Math.max(0, Math.min(400, (Date.parse(p.at) - start) / 86400000 * 400))},${62 - p.free_mem_gb! / max * 58}`).join(' ')} />
      {points.map((p, i) => <circle key={`${p.at}-${i}`} cx={Math.max(0, Math.min(400, (Date.parse(p.at) - start) / 86400000 * 400))} cy={62 - p.free_mem_gb! / max * 58} r="2" fill="var(--primary)"><title>{dateTime(p.at)}: {gb(p.free_mem_gb)}</title></circle>)}
    </svg> : <div className="flex h-20 items-center text-xs text-muted-foreground">{t('No memory readings yet.')}</div>}
    <div className="flex justify-between text-[11px] text-muted-foreground"><span>{t('24 hours ago')}</span><span>{t('Now')}</span></div>
  </figure>;
}
function MachineCard({ machine: m, project, index }: { machine: MachineView; project: string; index: number }) {
  const r = m.latest;
  const { check, remove, roles } = useMachineChanges(project);
  const [installing, setInstalling] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const jobs = m.jobs ?? [];
  const suggested = m.suggestions.roles.map(s => s.role).filter(r => !m.roles.includes(r));
  return <Card id={`machine-${m.id}`} data-machine={m.id} className="rise lift scroll-mt-20" style={nth(index)}><CardContent className="grid gap-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h2 className="font-semibold break-words">{m.name}</h2><p className="text-xs text-muted-foreground">{m.id} · {m.os}</p></div>
      <Badge tone={!r ? 'neutral' : r.reachable ? 'success' : 'danger'}>{!r ? t('Not probed yet') : r.reachable ? t('Reachable') : t('Unreachable')}</Badge>
    </div>
    <div className="flex flex-wrap gap-1">{m.roles.map(role => <Badge key={role} tone="outline">{role}</Badge>)}<Badge tone="neutral">{t('{n} slots', { n: m.slots })}</Badge>{m.timing_allowed && <Badge tone="outline">{t('Timing allowed')}</Badge>}</div>
    <p className="text-xs text-muted-foreground break-words">{[m.hardware.cpu, m.hardware.ram_gb ? gb(m.hardware.ram_gb) : '', m.hardware.gpu].filter(Boolean).join(' · ')}</p>
    {r?.error && <p className="text-sm text-destructive">{t('Health probe failed. Check the connection and probe tools.')}</p>}
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t('Free / total memory')}</dt><dd className={r?.free_mem_gb !== undefined && r.free_mem_gb < m.min_free_mem_gb ? 'text-destructive font-medium' : 'font-medium'}>{gb(r?.free_mem_gb)} / {gb(r?.total_mem_gb)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('CPU load')}</dt><dd className="font-medium">{r?.load === undefined ? '—' : `${(r.load * 100).toFixed(0)}%`}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('Uptime')}</dt><dd>{r?.uptime_seconds === undefined ? '—' : t('{n} hours', { n: Math.floor(r.uptime_seconds / 3600) })}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('Last probe')}</dt><dd title={r ? dateTime(r.at) : ''}>{r ? ago(r.at) : t('Not probed yet')}</dd></div>
    </dl>
    <div><h3 className="text-xs text-muted-foreground">{t('Free disk')}</h3>{r?.disks.length ? r.disks.map(d => <p key={d.mount} className={`mt-1 break-words text-sm ${d.free_gb / d.total_gb < 0.1 ? 'text-destructive' : ''}`}>{d.mount}: {gb(d.free_gb)} / {gb(d.total_gb)} ({(d.free_gb / d.total_gb * 100).toFixed(0)}%)</p>) : <p className="text-sm">—</p>}</div>
    <div className="border-t pt-3"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('Configuration')}</h3>
      {suggested.length > 0 && <Button size="sm" variant="outline" disabled={roles.isPending} onClick={() => roles.mutate({ id: m.id, roles: [...m.roles, ...suggested] })}>{t('Add as {roles}', { roles: suggested.map(roleTitle).join(t(', ')) })}</Button>}</div>
      <CapabilitySummary caps={m.capabilities} suggestions={m.suggestions} current={m.roles} onInstall={setInstalling} /></div>
    <MachineJobs project={project} jobs={jobs} />
    <InstallDialog project={project} machine={m.id} jobs={jobs} item={installing} onClose={() => setInstalling(null)} />
    <MemoryHistory history={m.history} />
    <div className="border-t pt-3"><h3 className="mb-2 text-sm font-semibold">{t('Services')} <span className="text-xs text-muted-foreground">{r ? r.services.filter(s => s.up).length : '—'}/{m.services.length}</span></h3>
      {m.services.length ? <ul className="grid gap-3">{m.services.map(s => {
        const up = r?.services.find(v => v.id === s.id)?.up;
        return <li key={s.id}><div className="flex items-center justify-between gap-2"><span className="break-all text-sm font-medium">{s.id}</span><Badge tone={up === undefined ? 'neutral' : up ? 'success' : 'danger'}>{up === undefined ? t('Not probed yet') : up ? t('Up') : t('Down')}</Badge></div>{s.start_hint && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{t('Start hint')}: {s.start_hint}</p>}</li>;
      })}</ul> : <p className="text-xs text-muted-foreground">{t('No services configured.')}</p>}
    </div>
    {m.notes && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{m.notes}</p>}
    <div className="flex justify-end gap-1 border-t pt-2">
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="size-3.5" />{t('Edit')}</Button>
      <Button size="sm" variant="ghost" disabled={check.isPending} onClick={() => check.mutate(m.id)}><RefreshCw className={`size-3.5 ${check.isPending ? 'animate-spin' : ''}`} />{t('Probe now')}</Button>
      <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { if (window.confirm(t('Remove {id} from the registry? The machine itself is not touched.', { id: m.id }))) remove.mutate(m.id); }}><Trash2 className="size-3.5" />{t('Remove')}</Button>
    </div>
    {editing && <EditMachineDialog project={project} machine={m} open={editing} onOpenChange={setEditing} />}
  </CardContent></Card>;
}
export function MachinesPage() {
  const project = useProjectId();
  const query = useMachines(project);
  const workers = useWorkers(project);
  const overview = useOverview(project);
  const [adding, setAdding] = useState(false);
  const addButton = <Button onClick={() => setAdding(true)}><Plus className="size-4" />{t('Add a machine')}</Button>;
  return <><PageHeader title={t('Machines')} count={query.data?.machines.length} actions={addButton}>{t('Machine health and services. Readings refresh with each probe.')}</PageHeader>
    {query.isError ? <ErrorBox error={query.error} /> : !query.data ? <Skeleton className="h-64" /> : query.data.machines.length ? <div className="grid gap-4"><FleetMap machines={query.data.machines} workers={workers.data?.workers ?? []} running={overview.data?.running.items ?? []} /><div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">{query.data.machines.map((m, i) => <MachineCard key={m.id} machine={m} project={project} index={i + 1} />)}</div></div> : <EmptyState icon={<Server />} title={t('No machines yet')} action={addButton}>{t('No machines yet. Add one with the guide: it sets up SSH, tests the connection and writes the registry.')}</EmptyState>}
    <AddMachineDialog project={project} taken={query.data?.machines.map(m => m.id) ?? []} open={adding} onOpenChange={setAdding} />
  </>;
}
