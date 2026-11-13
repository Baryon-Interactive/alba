import { stringify } from 'yaml';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import { machinesFile, type MachinesConfig } from '../machines/config.ts';
import { editMachine, testSsh, type ConnectionTest, type MachineOp } from '../machines/edit.ts';
import { probeMachines } from '../machines/probe.ts';
import { editSshHost, readSshHost, type SshAddressChange } from '../machines/ssh-config.ts';
import type { Orders } from '../orders/service.ts';
import { systemProbes } from '../tick/gather.ts';
import { parseSetArgs } from '../workers/edit.ts';

export const MACHINES_EDIT_USAGE = 'Usage: alba machines edit <id> [field=value ...] [ssh.hostname=H] [ssh.user=U] [ssh.port=P] [--dry-run] [--json]';

const CONNECTION: Record<ConnectionTest['category'], string> = {
  ok: 'connected', unresolved: 'the alias does not resolve', refused: 'connection refused (no SSH server listening)', timeout: 'no answer from that address',
  denied: 'the key was refused', 'host-key': 'the host key changed (remove the old known_hosts line if the machine was reinstalled)', 'no-ssh': 'no ssh program on this computer', failed: 'SSH failed (run "ssh <alias> hostname" to see why)',
};

/** Splits `ssh.hostname=…` style arguments (the alias's address in the SSH config) from the registry fields. */
function sshPart(ops: MachineOp[]): { registry: MachineOp[]; ssh?: SshAddressChange } {
  const ssh: SshAddressChange = {};
  const registry = ops.filter(op => {
    if (op.path[0] !== 'ssh') return true;
    const key = op.path[1];
    if (op.path.length !== 2 || !['hostname', 'user', 'port'].includes(key)) fail('Unknown SSH field "{field}": use ssh.hostname, ssh.user or ssh.port.', { field: op.path.join('.') });
    if (key === 'port') ssh.port = op.value === undefined ? null : typeof op.value === 'number' ? op.value : Number.NaN;
    else ssh[key as 'hostname' | 'user'] = op.value === undefined ? '' : String(op.value);
    return false;
  });
  return { registry, ...(Object.keys(ssh).length ? { ssh } : {}) };
}

/**
 * `alba machines edit <id>`: without changes, the entry and the Host block of its alias; with `field=value` arguments, changes
 * the registry entry; with `ssh.hostname=` (and `ssh.user=`, `ssh.port=`), the address of its alias in the SSH config, then
 * tests the connection and probes the machine. Both parts are checked before either is written.
 */
export async function machinesEdit(cfg: ProjectConfig, orders: Orders, config: MachinesConfig, rest: string[], options: { dryRun: boolean; workers?: string; json?: boolean }): Promise<string> {
  const [id, ...args] = rest;
  if (!id) fail(MACHINES_EDIT_USAGE);
  const current = config.machines.find(m => m.id === id);
  if (!current) fail('No machine "{id}".', { id });
  const file = machinesFile(cfg, options.workers).file!;
  if (!args.length) {
    const host = 'ssh' in current.connect ? readSshHost(current.connect.ssh) : undefined;
    if (options.json) return JSON.stringify({ file, machine: current, ...(host ? { ssh: host } : {}) }, null, 2);
    const out = [`# ${file}`, stringify([current]).trimEnd()];
    if (host) out.push('', `# ${host.file}${host.line ? ` (line ${host.line})` : ''}`, host.block?.trimEnd() ?? '', ...host.problems.map(p => `# ${p}`));
    return out.join('\n');
  }
  const { registry, ssh } = sshPart(parseSetArgs(args));
  const now = new Date();
  const planned = registry.length ? editMachine(file, id, registry, { dryRun: true, now }) : undefined;
  const machine = planned?.machine ?? current;
  const alias = 'ssh' in machine.connect ? machine.connect.ssh : undefined;
  if (ssh && !alias) fail('{id} is this computer (connect: local); it has no SSH address to change.', { id });
  const sshPlan = ssh ? editSshHost(alias!, ssh, { dryRun: true, now }) : undefined;
  const lines: string[] = [];
  const say = (registryChanged: string[], sshOut: typeof sshPlan, verb: string) => {
    lines.push(registryChanged.length ? `${file}: ${verb} ${registryChanged.join(', ')}` : registry.length ? `${file}: nothing to change` : '');
    if (sshOut) lines.push(sshOut.changed.length ? `${sshOut.file}: ${verb} ${sshOut.changed.join(', ')} of Host ${sshOut.alias}\n--- before\n${sshOut.before}--- after\n${sshOut.after.trimEnd()}` : `${sshOut.file}: Host ${sshOut.alias} already has that address`);
  };
  if (options.dryRun) {
    say(planned?.changed ?? [], sshPlan, 'would change');
    if (options.json) return JSON.stringify({ id, file, dryRun: true, changed: planned?.changed ?? [], ...(sshPlan ? { ssh: sshPlan } : {}) }, null, 2);
    return [...lines.filter(Boolean), 'Nothing was written (--dry-run).'].join('\n');
  }
  const written = registry.length ? editMachine(file, id, registry, { now }) : undefined;
  if (written?.changed.length) orders.record('*', 'machines.edited', { id, changed: written.changed, ...(written.backup ? { backup: written.backup } : {}), by: 'cli' });
  const sshOut = ssh ? editSshHost(alias!, ssh, { now }) : undefined;
  if (sshOut?.changed.length) orders.record('*', 'machines.ssh-config', { alias: alias!, changed: sshOut.changed, ...(sshOut.backup ? { backup: sshOut.backup } : {}), by: 'cli' });
  say(written?.changed ?? [], sshOut, 'changed');
  for (const b of [written?.backup, sshOut?.backup]) if (b) lines.push(`backup: ${b}`);
  let connection: ConnectionTest | undefined;
  if (sshOut?.changed.length || written?.changed.some(c => c === 'os' || c === 'connect' || c.startsWith('connect.'))) {
    connection = alias ? await testSsh(alias) : { ok: true, category: 'ok', seconds: 0 };
    lines.push(`connection: ${CONNECTION[connection.category]}${connection.remoteName ? ` (${connection.remoteName})` : ''}, ${connection.seconds} s`);
    if (connection.ok) {
      const view = (await probeMachines(cfg, systemProbes, { force: true, id, workersFile: options.workers })).find(v => v.id === id);
      const r = view?.latest;
      if (r) lines.push(r.error ? 'probe: connected, but the health probe failed' : `probe: ${r.free_mem_gb?.toFixed(1) ?? '?'} / ${r.total_mem_gb?.toFixed(1) ?? '?'} GB free, ${r.disks.length} disk(s)`);
    }
  }
  if (options.json) return JSON.stringify({ id, file, dryRun: false, changed: written?.changed ?? [], ...(written?.backup ? { backup: written.backup } : {}), ...(sshOut ? { ssh: sshOut } : {}), ...(connection ? { connection } : {}) }, null, 2);
  return lines.filter(Boolean).join('\n');
}
