import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ENGINE_IDS } from './engines/index.ts';
import type { ProjectConfig } from '../config.ts';

export type ServiceCheck = { tcp: string } | { http: string } | { process: string } | { command: string[] };
export interface MachineService { id: string; check: ServiceCheck; start_hint?: string }
export interface RoleRequirement { tools: string[]; min_threads?: number; min_ram_gb?: number }
export type RoleRequirements = Record<string, RoleRequirement>;
export interface Machine {
  workspace?: string;
  repos?: Record<string, string>;
  role_requirements?: RoleRequirements;
  engine?: string;
  id: string; name: string; os: 'windows' | 'linux' | 'macos';
  connect: { local: true } | { ssh: string };
  hardware: { cpu?: string; ram_gb?: number; gpu?: string };
  roles: string[]; slots: number; min_free_mem_gb: number; timing_allowed: boolean; notes?: string;
  services: MachineService[];
}
export interface MachinesConfig { probe_minutes: number; machines: Machine[] }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function object(v: unknown, keys: string[], at: string): Record<string, unknown> {
  if (!record(v)) throw new Error(`${at}: must be a mapping.`);
  const unknown = Object.keys(v).filter(k => !keys.includes(k));
  if (unknown.length) throw new Error(`${at}: unknown key(s): ${unknown.join(', ')}.`);
  return v;
}
function text(v: unknown, at: string, multiline = false): string {
  if (typeof v !== 'string' || !v.trim() || (multiline ? /\0/ : /[\0\r\n]/).test(v)) throw new Error(`${at}: must be nonempty ${multiline ? '' : 'single-line '}text without NUL.`);
  return v;
}
function number(v: unknown, at: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new Error(`${at}: must be a number >= ${min}.`);
  return v;
}
function id(v: unknown, at: string): string {
  const s = text(v, at);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) throw new Error(`${at}: use lower-case letters, digits, hyphens or underscores (max 64).`);
  return s;
}
export function tcpAddress(value: string): { host: string; port: number } {
  const match = /^(\[[a-fA-F0-9:]+\]|[A-Za-z0-9._-]+):(\d+)$/.exec(value);
  if (!match || +match[2] < 1 || +match[2] > 65535) throw new Error('tcp check: expected host:port (port 1–65535).');
  return { host: match[1].replace(/^\[|\]$/g, ''), port: +match[2] };
}
export function validateMachines(raw: unknown, file = 'machines.yaml'): MachinesConfig {
  const top = object(raw, ['probe_minutes', 'machines'], file);
  const probe_minutes = number(top.probe_minutes ?? 5, `${file}.probe_minutes`, 0.01);
  if (!Array.isArray(top.machines)) throw new Error(`${file}.machines: must be a list.`);
  const ids = new Set<string>();
  const machines = top.machines.map((value, index): Machine => {
    const at = `${file}.machines[${index}]`;
    const v = object(value, ['engine', 'id', 'name', 'os', 'connect', 'hardware', 'roles', 'slots', 'min_free_mem_gb', 'timing_allowed', 'notes', 'services', 'workspace', 'repos', 'role_requirements'], at);
    if (v.engine !== undefined && !ENGINE_IDS.includes(String(v.engine))) throw new Error(`${at}.engine: expected ${ENGINE_IDS.join(', ')}.`);
    const machineId = id(v.id, `${at}.id`);
    if (ids.has(machineId)) throw new Error(`${at}.id: duplicate ${machineId}.`);
    ids.add(machineId);
    if (!['windows', 'linux', 'macos'].includes(String(v.os))) throw new Error(`${at}.os: expected windows, linux or macos.`);
    const c = object(v.connect, ['local', 'ssh'], `${at}.connect`);
    if (Object.keys(c).length !== 1 || (c.local !== true && typeof c.ssh !== 'string')) throw new Error(`${at}.connect: exactly one of local: true or ssh: alias is required.`);
    if (c.ssh !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(text(c.ssh, `${at}.connect.ssh`))) throw new Error(`${at}.connect.ssh: expected an SSH config alias using letters, digits, hyphens or underscores.`);
    const h = object(v.hardware ?? {}, ['cpu', 'ram_gb', 'gpu'], `${at}.hardware`);
    const hardware: Machine['hardware'] = {};
    for (const k of ['cpu', 'gpu'] as const) if (h[k] !== undefined) hardware[k] = text(h[k], `${at}.hardware.${k}`);
    if (h.ram_gb !== undefined) hardware.ram_gb = number(h.ram_gb, `${at}.hardware.ram_gb`, 0.01);
    if (v.roles !== undefined && (!Array.isArray(v.roles) || v.roles.some(r => typeof r !== 'string' || !r.trim()))) throw new Error(`${at}.roles: must be a list of tags.`);
    const slots = number(v.slots ?? 1, `${at}.slots`, 1);
    if (!Number.isInteger(slots)) throw new Error(`${at}.slots: must be a whole number.`);
    if (v.timing_allowed !== undefined && typeof v.timing_allowed !== 'boolean') throw new Error(`${at}.timing_allowed: must be boolean.`);
    if (v.services !== undefined && !Array.isArray(v.services)) throw new Error(`${at}.services: must be a list.`);
    const serviceIds = new Set<string>();
    const services = ((v.services ?? []) as unknown[]).map((entry, i): MachineService => {
      const where = `${at}.services[${i}]`, s = object(entry, ['id', 'check', 'start_hint'], where);
      const sid = id(s.id, `${where}.id`);
      if (serviceIds.has(sid)) throw new Error(`${where}.id: duplicate ${sid}.`);
      serviceIds.add(sid);
      const check = object(s.check, ['tcp', 'http', 'process', 'command'], `${where}.check`);
      if (Object.keys(check).length !== 1) throw new Error(`${where}.check: exactly one check is required.`);
      if ('command' in check) {
        if (!Array.isArray(check.command) || !check.command.length) throw new Error(`${where}.check.command: expected nonempty argv.`);
        check.command.forEach((arg, n) => { if (typeof arg !== 'string' || arg.includes('\0') || (n === 0 && !arg.trim())) throw new Error(`${where}.check.command: invalid argv.`); });
      } else {
        const key = Object.keys(check)[0], val = text(check[key], `${where}.check.${key}`);
        if (key === 'tcp') tcpAddress(val);
        if (key === 'http') {
          const url = URL.canParse(val) ? new URL(val) : undefined;
          if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${where}.check.http: expected HTTP(S) URL without credentials.`);
        }
        if (key === 'process' && !/^[A-Za-z0-9_.+-]+$/.test(val)) throw new Error(`${where}.check.process: expected executable name only.`);
      }
      return { id: sid, check: check as ServiceCheck, ...(s.start_hint === undefined ? {} : { start_hint: text(s.start_hint, `${where}.start_hint`, true) }) };
    });
    const paths = v.os === 'windows' ? path.win32 : path.posix;
    const remotePath = (value: unknown, where: string): string => {
      const p = text(value, where);
      if (!paths.isAbsolute(p) || (v.os === 'windows' && !/^[A-Za-z]:\//.test(p)) || p.includes('\\') || /[\s"'`$;&|<>]/.test(p) || p.split('/').includes('..') || paths.parse(p).root === p) throw new Error(`${where}: expected an absolute non-root path with forward slashes and no spaces or shell characters.`);
      return p.replace(/\/+$/, '');
    };
    const workspace = v.workspace === undefined ? undefined : remotePath(v.workspace, `${at}.workspace`);
    let repos: Record<string, string> | undefined;
    if (v.repos !== undefined) {
      if (!record(v.repos)) throw new Error(`${at}.repos: must map project ids to bare repository paths.`);
      repos = Object.fromEntries(Object.entries(v.repos).map(([project, p]) => [id(project, `${at}.repos`), remotePath(p, `${at}.repos.${project}`)]));
    }
    const role_requirements: RoleRequirements = {};
    if (v.role_requirements !== undefined) {
      if (!record(v.role_requirements)) throw new Error(`${at}.role_requirements: must map role names to requirements.`);
      for (const [role, raw] of Object.entries(v.role_requirements)) {
        const where = `${at}.role_requirements.${id(role, `${at}.role_requirements`)}`;
        const r = object(raw, ['tools', 'min_threads', 'min_ram_gb'], where);
        if (!Array.isArray(r.tools) || !r.tools.length || r.tools.some(t => typeof t !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t))) throw new Error(`${where}.tools: expected a nonempty list of tool names.`);
        const min_threads = r.min_threads === undefined ? undefined : number(r.min_threads, `${where}.min_threads`, 1);
        if (min_threads !== undefined && !Number.isInteger(min_threads)) throw new Error(`${where}.min_threads: must be a whole number.`);
        role_requirements[role] = { tools: [...new Set(r.tools as string[])], ...(min_threads === undefined ? {} : { min_threads }), ...(r.min_ram_gb === undefined ? {} : { min_ram_gb: number(r.min_ram_gb, `${where}.min_ram_gb`) }) };
      }
    }
    return { ...(workspace ? { workspace } : {}), ...(repos ? { repos } : {}), ...(v.role_requirements === undefined ? {} : { role_requirements }), ...(v.engine === undefined ? {} : { engine: v.engine as string }), id: machineId, name: text(v.name, `${at}.name`), os: v.os as Machine['os'], connect: c as Machine['connect'], hardware, roles: (v.roles ?? []) as string[], slots,
      min_free_mem_gb: number(v.min_free_mem_gb ?? 0, `${at}.min_free_mem_gb`), timing_allowed: v.timing_allowed === true,
      ...(v.notes === undefined ? {} : { notes: text(v.notes, `${at}.notes`, true) }), services };
  });
  return { probe_minutes, machines };
}
/** Where the registry lives: ALBA_MACHINES, then `machines:` in the project file, then machines.yaml next to the workers file. */
export function machinesFile(project: ProjectConfig, workersFile?: string): { file?: string; explicit: boolean } {
  const explicit = process.env.ALBA_MACHINES ?? project.machines;
  const workers = workersFile ?? process.env.ALBA_WORKERS ?? project.workers;
  return { file: explicit ?? (workers ? path.join(path.dirname(workers), 'machines.yaml') : undefined), explicit: !!explicit };
}
export function loadMachines(project: ProjectConfig, workersFile?: string): MachinesConfig {
  const { file, explicit } = machinesFile(project, workersFile);
  if (!file || (!explicit && !existsSync(file))) return { probe_minutes: 5, machines: [] };
  try { return validateMachines(parse(readFileSync(file, 'utf8')), file); }
  catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
}
