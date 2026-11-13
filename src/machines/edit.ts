import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSeq, parse } from 'yaml';
import { assign, editYaml, EditRefused, findItem, plainAt, type EditOutcome } from '../yamledit.ts';
import { validateMachines, type Machine } from './config.ts';

const EMPTY = 'probe_minutes: 5\nmachines: []\n';

function validateText(text: string, file: string): void {
  let raw: unknown;
  try { raw = parse(text); } catch (e) { throw new EditRefused(`${file} is not valid YAML: ${(e as Error).message.split('\n')[0]}`); }
  try { validateMachines(raw, file); } catch (e) { throw new EditRefused((e as Error).message); }
}

/** Checks one machine on its own, with the same rules as the registry. Returns the normalized entry. */
export function validateMachine(input: unknown): Machine {
  try { return validateMachines({ machines: [input] }, 'machine').machines[0]; }
  catch (e) { throw new EditRefused((e as Error).message.replace(/^machine\.machines\[0\]\.?/, '')); }
}

/** Adds a machine at the end of the registry, creating the file when there is none yet. Comments in the file are kept. */
export function addMachine(file: string, input: unknown, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome & { machine: Machine } {
  const machine = validateMachine(input);
  if (!existsSync(file)) {
    if (options.dryRun) return { changed: ['*'], dryRun: true, machine };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, EMPTY, 'utf8');
  }
  const out = editYaml(file, doc => {
    let list = doc.get('machines', true);
    if (!isSeq(list)) { doc.set('machines', doc.createNode([])); list = doc.get('machines', true); }
    if (!isSeq(list)) throw new EditRefused(`${file}: "machines" must be a list.`);
    if (findItem(doc, ['machines'], 'id', machine.id)) throw new EditRefused(`There is a machine "${machine.id}" already.`, [{ field: 'id', message: `There is a machine "${machine.id}" already.` }]);
    const entry: Record<string, unknown> = { ...machine };
    for (const k of ['notes'] as const) if (entry[k] === undefined) delete entry[k];
    const node = doc.createNode(entry);
    (node as { spaceBefore?: boolean }).spaceBefore = list.items.length > 0;
    list.items.push(node);
    return ['*'];
  }, text => validateText(text, file), options);
  return { ...out, machine };
}

/** Removes a machine from the registry; its stored readings are dropped on the next probe. */
export function removeMachine(file: string, id: string, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!existsSync(file)) throw new EditRefused(`No machine "${id}".`);
  return editYaml(file, doc => {
    const item = findItem(doc, ['machines'], 'id', id);
    if (!item) throw new EditRefused(`No machine "${id}".`);
    doc.deleteIn(['machines', item.index]);
    return ['*'];
  }, text => validateText(text, file), options);
}

/** A change of one field of a machine: `path` is the key (or a dotted key inside, like `hardware.ram_gb`); `undefined` removes it. */
export interface MachineOp { path: string[]; value: unknown }

/** The fields `machines edit` and the console's edit form change. `id` is not one of them: readings are stored by id. */
export const MACHINE_EDIT_FIELDS = ['name', 'os', 'connect', 'hardware', 'roles', 'slots', 'min_free_mem_gb', 'timing_allowed', 'notes', 'workspace', 'repos', 'services', 'engine', 'role_requirements'] as const;

/** The `set` of a request (a field → its new value, `null` removes it) as field changes. */
export function machineOpsFromSet(set: unknown): MachineOp[] {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new EditRefused('"set" maps fields to their new values.');
  return Object.entries(set as Record<string, unknown>).map(([key, value]) => ({ path: key.split('.').filter(Boolean), value: value === null ? undefined : value }));
}

/**
 * Changes fields of one machine of the registry. Fields not named stay as written, with their comments. The whole entry is
 * validated like an added one, and the whole file like the registry; the old file is kept as a backup. A dry run writes nothing.
 */
export function editMachine(file: string, id: string, ops: MachineOp[], options: { dryRun?: boolean; now?: Date } = {}): EditOutcome & { machine: Machine } {
  if (!ops.length) throw new EditRefused('Nothing to change.');
  for (const op of ops) {
    const top = op.path[0];
    if (top === 'id') throw new EditRefused('A machine\'s id cannot be changed (its readings are stored under it): remove it and add it again under the new id.', [{ field: 'id', message: 'The id cannot be changed.' }]);
    if (!(MACHINE_EDIT_FIELDS as readonly string[]).includes(top ?? '')) throw new EditRefused(`Unknown machine field "${op.path.join('.')}". Fields: ${MACHINE_EDIT_FIELDS.join(', ')}.`, [{ field: op.path.join('.'), message: 'Unknown field.' }]);
    if (op.path.length > 1 && !['hardware', 'repos'].includes(top)) throw new EditRefused(`Set "${top}" as a whole (only hardware.* and repos.* can be changed key by key).`, [{ field: top, message: 'Set this field as a whole.' }]);
  }
  if (!existsSync(file)) throw new EditRefused(`No machine "${id}".`);
  let machine: Machine | undefined;
  const out = editYaml(file, doc => {
    const item = findItem(doc, ['machines'], 'id', id);
    if (!item) throw new EditRefused(`No machine "${id}".`);
    const old = plainAt(doc, ['machines', item.index]) as Record<string, unknown>;
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(old));
    for (const op of ops) {
      if (op.path.length === 1) { if (op.value === undefined) delete next[op.path[0]]; else next[op.path[0]] = op.value; continue; }
      const parent = (next[op.path[0]] && typeof next[op.path[0]] === 'object' ? next[op.path[0]] : (next[op.path[0]] = {})) as Record<string, unknown>;
      if (op.value === undefined) delete parent[op.path[1]]; else parent[op.path[1]] = op.value;
    }
    machine = validateMachine(next);
    const changed: string[] = [];
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) changed.push(...assign(doc, ['machines', item.index, key], next[key], old[key]).map(n => n.replace(`machines.${item.index}.`, '')));
    return changed;
  }, text => validateText(text, file), options);
  return { ...out, machine: machine! };
}

/** Replaces a machine's roles (for example with the roles its capability scan suggests). */
export function setMachineRoles(file: string, id: string, roles: unknown, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!Array.isArray(roles) || roles.some(r => typeof r !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r))) throw new EditRefused('Roles are a list of tags: lower-case letters, digits, hyphens or underscores.', [{ field: 'roles', message: 'Roles are a list of tags.' }]);
  if (!existsSync(file)) throw new EditRefused(`No machine "${id}".`);
  return editYaml(file, doc => {
    const item = findItem(doc, ['machines'], 'id', id);
    if (!item) throw new EditRefused(`No machine "${id}".`);
    doc.setIn(['machines', item.index, 'roles'], doc.createNode([...new Set(roles as string[])]));
    return ['roles'];
  }, text => validateText(text, file), options);
}

// ---- SSH onboarding helpers. Nothing here reads or prints private keys, passwords or full process command lines. ----

export interface SshHostInput { alias: string; hostname: string; user: string; identity_file?: string; port?: number }
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._$-]{0,63}$/;
const KEYFILE = /^[^\0\r\n"]{1,260}$/;

export const sshDir = (home = os.homedir()) => path.join(home, '.ssh');

/** The SSH config block for a machine, as a person would write it. */
export function sshHostBlock(input: SshHostInput): string {
  const problems: { field: string; message: string }[] = [];
  if (!ALIAS.test(input.alias)) problems.push({ field: 'alias', message: 'Use letters, digits, hyphens or underscores for the alias.' });
  if (!HOST.test(input.hostname)) problems.push({ field: 'hostname', message: 'Enter an IP address or a host name.' });
  if (!USER.test(input.user)) problems.push({ field: 'user', message: 'Enter the login name on that machine.' });
  if (input.identity_file !== undefined && input.identity_file !== '' && (!KEYFILE.test(input.identity_file) || /\.pub$/i.test(input.identity_file))) problems.push({ field: 'identity_file', message: 'Enter the private key file (not the .pub file).' });
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) problems.push({ field: 'port', message: 'Port is 1–65535.' });
  if (problems.length) throw new EditRefused(problems[0].message, problems);
  const lines = [`Host ${input.alias}`, `    HostName ${input.hostname}`, `    User ${input.user}`];
  if (input.port && input.port !== 22) lines.push(`    Port ${input.port}`);
  if (input.identity_file) lines.push(`    IdentityFile ${/\s/.test(input.identity_file) ? `"${input.identity_file}"` : input.identity_file}`, '    IdentitiesOnly yes');
  return lines.join('\n') + '\n';
}

/** Does the SSH config already name this alias in a Host line? */
export function sshHasHost(text: string, alias: string): boolean {
  return text.split(/\r?\n/).some(line => {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    return !!m && m[1].trim().split(/\s+/).some(p => p === alias);
  });
}

/** Appends a Host block to the SSH config of the user running alba. Refuses when the alias exists; keeps a backup. */
export function appendSshHost(input: SshHostInput, options: { dir?: string; now?: Date } = {}): { file: string; block: string; backup?: string } {
  const block = sshHostBlock(input);
  const dir = options.dir ?? sshDir(), file = path.join(dir, 'config');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (sshHasHost(text, input.alias)) throw new EditRefused(`The SSH config already has "Host ${input.alias}". Edit it by hand or pick another alias.`, [{ field: 'alias', message: `"${input.alias}" is already in the SSH config.` }]);
  mkdirSync(dir, { recursive: true });
  let backup: string | undefined;
  if (text) { backup = `${file}.bak-${(options.now ?? new Date()).toISOString().replace(/[-:]/g, '').slice(0, 15)}`; copyFileSync(file, backup); }
  const crlf = /\r\n/.test(text);
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  const out = (text ? '\n' : '') + block;
  appendFileSync(file, (sep + out).replace(/\n/g, crlf ? '\r\n' : '\n'), 'utf8');
  return { file, block, backup };
}

/** Public keys of the user running alba (only `*.pub` files), so the guide can show what to authorize on the new machine. */
export function hostPublicKeys(dir = sshDir()): { file: string; key: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.pub')).sort().slice(0, 8).flatMap(f => {
    const key = readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/)[0] ?? '';
    return /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-|sk-)/.test(key) && !/PRIVATE KEY/.test(key) ? [{ file: f, key }] : [];
  });
}

export type ConnectionCategory = 'ok' | 'unresolved' | 'refused' | 'timeout' | 'denied' | 'host-key' | 'no-ssh' | 'failed';
export interface ConnectionTest { ok: boolean; category: ConnectionCategory; remoteName?: string; detectedOs?: 'windows' | 'linux' | 'macos'; seconds: number }

/** Sorts an SSH failure into a cause a person can act on. Only the category leaves this function, never the raw text. */
export function classifySsh(stderr: string): ConnectionCategory {
  if (/Could not resolve hostname|Name or service not known|No such host/i.test(stderr)) return 'unresolved';
  if (/Connection refused/i.test(stderr)) return 'refused';
  if (/timed out|No route to host|Network is unreachable|Connection reset/i.test(stderr)) return 'timeout';
  if (/Permission denied|Too many authentication failures|no mutual signature/i.test(stderr)) return 'denied';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'host-key';
  return 'failed';
}

type Exec = (program: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>;
const realExec: Exec = (program, args, timeoutMs) => new Promise(resolve => {
  execFile(program, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const e = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
    resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: e?.code === 'ENOENT' });
  });
});

/** One non-interactive login to the alias. A first connection records the host key (accept-new); a changed key still fails. */
export async function testSsh(alias: string, exec: Exec = realExec): Promise<ConnectionTest> {
  if (!ALIAS.test(alias)) throw new EditRefused('Use letters, digits, hyphens or underscores for the alias.', [{ field: 'alias', message: 'Use letters, digits, hyphens or underscores for the alias.' }]);
  const started = Date.now();
  const r = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=accept-new', alias, 'hostname'], 20000);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (r.missing) return { ok: false, category: 'no-ssh', seconds };
  if (r.code === 0) {
    // `uname -s` answers on Linux and macOS; the Windows shells do not have it.
    const u = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', alias, 'uname -s'], 20000);
    const name = u.stdout.trim();
    const detectedOs = u.code === 0 ? (/^Darwin/i.test(name) ? 'macos' : /^Linux/i.test(name) ? 'linux' : undefined) : /not recognized|is not recognised|CommandNotFoundException/i.test(u.stderr + u.stdout) ? 'windows' : undefined;
    return { ok: true, category: 'ok', remoteName: r.stdout.trim().split(/\r?\n/)[0]?.slice(0, 64), ...(detectedOs ? { detectedOs } : {}), seconds: Math.round((Date.now() - started) / 100) / 10 };
  }
  return { ok: false, category: classifySsh(r.stderr), seconds };
}
