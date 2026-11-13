import type { Machine } from '../../../src/machines/config';

export type CheckKind = 'tcp' | 'http' | 'process' | 'command';
export interface ServiceRow { id: string; kind: CheckKind; value: string; hint: string }

/** The edit form of a machine: every field as the text a person types. */
export interface MachineForm {
  name: string; os: Machine['os']; local: boolean; alias: string;
  cpu: string; gpu: string; ram: string;
  roles: string; slots: string; minFree: string; timing: boolean; notes: string;
  workspace: string; repos: string; services: ServiceRow[];
}

export const serviceRows = (services: Machine['services']): ServiceRow[] => services.map(s => {
  const kind = Object.keys(s.check)[0] as CheckKind;
  const raw = (s.check as Record<string, unknown>)[kind];
  return { id: s.id, kind, value: Array.isArray(raw) ? raw.join(' ') : String(raw), hint: s.start_hint ?? '' };
});

export function machineForm(m: Machine): MachineForm {
  return {
    name: m.name, os: m.os, local: 'local' in m.connect, alias: 'ssh' in m.connect ? m.connect.ssh : '',
    cpu: m.hardware.cpu ?? '', gpu: m.hardware.gpu ?? '', ram: m.hardware.ram_gb === undefined ? '' : String(m.hardware.ram_gb),
    roles: m.roles.join(', '), slots: String(m.slots), minFree: String(m.min_free_mem_gb), timing: m.timing_allowed, notes: m.notes ?? '',
    workspace: m.workspace ?? '', repos: Object.entries(m.repos ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'), services: serviceRows(m.services),
  };
}

const num = (s: string) => s.trim() === '' ? undefined : Number(s.trim());

/** What each field of the form becomes in the registry (`undefined`: the key is left out). */
function fields(f: MachineForm): Record<string, unknown> {
  const hardware: Record<string, unknown> = {};
  if (f.cpu.trim()) hardware.cpu = f.cpu.trim();
  if (f.gpu.trim()) hardware.gpu = f.gpu.trim();
  if (num(f.ram) !== undefined) hardware.ram_gb = num(f.ram);
  const repos = Object.fromEntries(f.repos.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const at = l.indexOf(':'); return at > 0 && !/^[A-Za-z]:\//.test(l) ? [l.slice(0, at).trim(), l.slice(at + 1).trim()] : [l, '']; }));
  return {
    name: f.name.trim(), os: f.os, connect: f.local ? { local: true } : { ssh: f.alias.trim() }, hardware,
    roles: f.roles.split(/[,\s]+/).map(r => r.trim()).filter(Boolean), slots: num(f.slots), min_free_mem_gb: num(f.minFree), timing_allowed: f.timing,
    notes: f.notes.trim() || undefined, workspace: f.workspace.trim() || undefined, repos: Object.keys(repos).length ? repos : undefined,
    services: f.services.filter(s => s.id.trim() || s.value.trim()).map(s => ({ id: s.id.trim(), check: s.kind === 'command' ? { command: s.value.split(' ').filter(Boolean) } : { [s.kind]: s.value.trim() }, ...(s.hint.trim() ? { start_hint: s.hint.trim() } : {}) })),
  };
}

/**
 * The `set` of an edit request: only the fields whose form value differs from what the machine's own values give
 * (so a field nobody touched is never rewritten), a cleared optional field as `null`.
 */
export function machineSet(original: Machine, form: MachineForm): Record<string, unknown> {
  const before = fields(machineForm(original)), after = fields(form), set: Record<string, unknown> = {};
  for (const key of Object.keys(after)) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) set[key] = after[key] === undefined ? null : after[key];
  return set;
}

/** The address part of an edit request: fields that differ from the Host block's current values; an empty port goes back to 22. */
export function sshSet(current: { hostname?: string; user?: string; port?: number }, form: { hostname: string; user: string; port: string }): { hostname?: string; user?: string; port?: number | null } | undefined {
  const out: { hostname?: string; user?: string; port?: number | null } = {};
  if (form.hostname.trim() && form.hostname.trim() !== (current.hostname ?? '')) out.hostname = form.hostname.trim();
  if (form.user.trim() && form.user.trim() !== (current.user ?? '')) out.user = form.user.trim();
  const port = form.port.trim() === '' || form.port.trim() === '22' ? undefined : Number(form.port.trim());
  if (port !== current.port && !(port === undefined && current.port === 22)) out.port = port === undefined ? null : port;
  return Object.keys(out).length ? out : undefined;
}
