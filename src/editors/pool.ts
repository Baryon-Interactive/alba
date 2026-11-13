import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { readStateJson, updateStateJson } from '../orders/state-files.ts';
import { usesOf } from '../resources/leases.ts';
import { excludeLocally } from '../skills/mount.ts';
import { loadMachines } from '../machines/config.ts';
import type { EditorPool } from './config.ts';
import { answers, findEditors, stopEditorsNow, type EditorSpec } from './editor-helper.mjs';

/** One editor slot: a port of a machine, held by an order's run. */
export interface EditorSlot {
  pool: string; machine: string; port: number; tag: string; run?: string; since: string; url: string; log: string;
  /** The run is on another machine: its SSH alias, and the editor helper's path there. */
  ssh?: string; remote_helper?: string;
  /** When the tick last could not stop the editor of an ended run (the slot is kept until it can). */
  stop_failed?: string;
  /** When the tick claimed the slot of an ended run to stop its editor: its port stays busy until the slot is gone, and a new start of the order takes another. */
  releasing?: string;
  /** The editor's spec (local runs), so Alba can find and stop the editor itself. */
  spec?: EditorSpec;
}

const SLOTS = '_editors.json';
const slash = (p: string) => p.replace(/\\/g, '/');

export const editorSlots = (project: ProjectConfig): EditorSlot[] => readStateJson<EditorSlot[]>(project, SLOTS, []);

/** The same slot (not a later one of the same order on the same port): `since` is set each time a slot is taken. */
const sameSlot = (a: EditorSlot, b: EditorSlot): boolean => a.tag === b.tag && a.pool === b.pool && a.machine === b.machine && a.port === b.port && a.since === b.since;

/** The free ports of a pool on one machine for an order, and the slot it already holds there (kept by its next run), from the slots now. */
function portsFor(slots: readonly EditorSlot[], tag: string, pool: EditorPool, machine: string): { mine?: EditorSlot; busy: EditorSlot[]; free: number[] } {
  const mine = slots.find(s => s.tag === tag && s.pool === pool.name && s.machine === machine && !s.releasing);
  const busy = slots.filter(s => s.pool === pool.name && s.machine === machine && s !== mine);
  return { mine, busy, free: (pool.machines[machine]?.ports ?? []).filter(p => !busy.some(s => s.port === p)) };
}

/**
 * Why the order cannot have an editor of the pool on that machine now (every port there is taken), or undefined. The pool's resource
 * counts the ports of all its machines; a run needs a port of its own machine.
 */
export function editorPortProblem(slots: readonly EditorSlot[], tag: string, pool: EditorPool, machine: string, planned = 0): string | undefined {
  const { mine, busy, free } = portsFor(slots, tag, pool, machine);
  if (mine || free.length > planned) return undefined;
  return t('every {pool} port on {machine} is taken ({list})', { pool: pool.name, machine, list: [...busy.map(s => `${s.port} ${s.tag}`), ...(planned ? [t('{n} planned in this pass', { n: planned })] : [])].join(', ') || '-' });
}

/** The editor pool an order uses (`uses: [<pool>]`, or the resource's match), if any. More than one is refused at start. */
export function editorPoolsOf(project: ProjectConfig, doc: OrderDoc): EditorPool[] {
  if (!project.editors) return [];
  const uses = usesOf(project, doc);
  return Object.values(project.editors).filter(p => uses.includes(p.name));
}

/** The machine a run is on: the worker's host, else the registry's local machine (`local` without a registry). */
export function runMachine(project: ProjectConfig, host: string | undefined, workersFile?: string): string {
  if (host) return host;
  try { return loadMachines(project, workersFile).machines.find(m => 'local' in m.connect)?.id ?? 'local'; } catch { return 'local'; }
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(worktree|port|log)\}/g, (_, k: string) => v[k]!);

/**
 * Takes a free port of the pool on the run's machine for the order, and writes the editor's spec and helper into the worktree.
 * `worktree` is where the editor runs (the host's copy for a remote run); `localWorktree` is where Alba writes the files.
 */
export function takeEditor(project: ProjectConfig, orders: Orders, doc: OrderDoc, pool: EditorPool, machine: string, where: { localWorktree: string; worktree: string; ssh?: string }, now: Date): { slot: EditorSlot; spec: EditorSpec } {
  const m = pool.machines[machine];
  if (!m) fail('{tag} cannot start now: it uses {pool}, which has no editor on {machine} (machines with one: {list}).', { tag: doc.order.tag, pool: pool.name, machine, list: Object.keys(pool.machines).join(', ') });
  const log = `${slash(where.worktree)}/.alba/editor.log`;
  let taken: EditorSlot | undefined;
  let spec!: EditorSpec;
  updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => {
    const { mine, busy, free } = portsFor(slots, doc.order.tag, pool, machine);
    const port = mine?.port ?? free[0];
    if (port === undefined) fail('{tag} cannot start now: every {pool} port on {machine} is taken ({list}).', { tag: doc.order.tag, pool: pool.name, machine, list: busy.map(s => `${s.port} ${s.tag}`).join(', ') });
    spec = specFor(pool, machine, port!, where.worktree, log);
    taken = {
      pool: pool.name, machine, port: port!, tag: doc.order.tag, since: now.toISOString(), url: spec.url, log,
      ...(where.ssh ? { ssh: where.ssh, remote_helper: `${slash(where.worktree)}/.alba/bin/editor.mjs` } : { spec }),
    };
    return [...slots.filter(s => s !== mine), taken];
  });
  mkdirSync(path.join(where.localWorktree, '.alba', 'bin'), { recursive: true });
  writeFileSync(path.join(where.localWorktree, '.alba', 'editor.json'), JSON.stringify(spec, null, 2) + '\n', 'utf8');
  copyFileSync(fileURLToPath(new URL('./editor-helper.mjs', import.meta.url)), path.join(where.localWorktree, '.alba', 'bin', 'editor.mjs'));
  excludeLocally(where.localWorktree, ['/.alba/']);
  orders.record(doc.order.tag, 'editor-slot', { pool: pool.name, machine, port: taken!.port, url: taken!.url });
  return { slot: taken!, spec };
}

function specFor(pool: EditorPool, machine: string, port: number, worktree: string, log: string): EditorSpec {
  const m = pool.machines[machine]!;
  const values = { worktree: slash(worktree), port: String(port), log };
  const args = pool.args.map(a => fill(a, values));
  const worktreeArg = pool.args.findIndex(a => a.includes('{worktree}'));
  return { pool: pool.name, port, program: m.program ?? pool.program, args, url: fill(pool.url, values), match: args[pool.args.findIndex(a => a.includes('{port}'))]!, ...(worktreeArg >= 0 ? { match_worktree: args[worktreeArg]! } : {}), log, ready_minutes: pool.ready_minutes, ...(m.desktop ? { desktop: true } : {}), state_file: `${slash(worktree)}/.alba/editor-state.json`,
    ...(pool.prepare ? { prepare: { ...pool.prepare, command: pool.prepare.command.map(a => fill(a, values)), cwd: slash(worktree), log: `${slash(worktree)}/.alba/editor-prepare.log` } } : {}) };
}

/** The run the slot belongs to, once the run is recorded (a slot of an earlier run that is being released keeps its run). */
export function bindEditor(project: ProjectConfig, tag: string, pool: string, run: string): void {
  updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => { for (const s of slots) if (s.tag === tag && s.pool === pool && !s.releasing) s.run = run; return slots; });
}

/** Gives a slot back without touching an editor (the run never started). A slot being released stays until its editor is stopped. */
export function dropEditor(project: ProjectConfig, tag: string, pool: string): void {
  updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => slots.filter(s => !(s.tag === tag && s.pool === pool && !s.releasing)));
}

/** Stops a slot's editor wherever it runs. Answers what was done, and whether the editor is known to be gone. */
export function stopSlotEditor(slot: EditorSlot): { done: string; stopped: boolean } {
  if (slot.spec) {
    const pids = stopEditorsNow(slot.spec);
    const left = pids.length ? findEditors(slot.spec) : [];
    if (left.length) return { done: `could not stop the editor (${left.join(', ')} still running)`, stopped: false };
    return { done: pids.length ? `stopped the editor (${pids.join(', ')})` : 'no editor was running', stopped: true };
  }
  if (slot.ssh && slot.remote_helper) {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', slot.ssh, `node "${slot.remote_helper}" stop`], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return r.status === 0
      ? { done: `on ${slot.ssh}: ${(r.stderr || r.stdout || '').trim().split('\n').at(-1) ?? 'stopped'}`, stopped: true }
      : { done: `on ${slot.ssh}: could not stop it (${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').at(-1)})`, stopped: false };
  }
  return { done: 'nothing to stop', stopped: true };
}

/**
 * The tick's part: a slot whose run has ended (any outcome: done, failed, stopped, crashed, held) has its editor stopped (by its
 * command line: this program with this port; nothing else) and is given back. The run's own wrapper normally did it already.
 * The slot is claimed under the state lock first (still the same slot, its run still ended, marked `releasing`), so a start of the
 * same order meanwhile takes another port instead of reusing this one and losing it when the slot is removed; only that slot is
 * removed afterwards.
 */
export function reconcileEditors(project: ProjectConfig, orders: Orders): string[] {
  if (!project.editors) return [];
  const out: string[] = [];
  const releasable = (s: EditorSlot): boolean => {
    let open = false;
    try { const doc = orders.get(s.tag); open = doc.runs.some(r => !r.ended && (!s.run || r.id === s.run)); } catch { /* the order is gone */ }
    // A slot taken by a start that is still being recorded (no run yet) is left for a minute.
    return !open && !(!s.run && !s.releasing && Date.now() - Date.parse(s.since) < 60000);
  };
  for (const seen of editorSlots(project)) {
    let slot: EditorSlot | undefined;
    updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => {
      const current = slots.find(s => sameSlot(s, seen));
      if (current && releasable(current)) { current.releasing ??= new Date().toISOString(); slot = { ...current }; }
      return slots;
    });
    if (!slot) continue;
    const { done, stopped } = stopSlotEditor(slot);
    // An editor that may still run keeps its port: the next run on it would otherwise find (and drive) the old editor.
    if (!stopped) {
      if (!slot.stop_failed) {
        updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => { for (const s of slots) if (sameSlot(s, slot!)) s.stop_failed = new Date().toISOString(); return slots; });
        try { orders.record(slot.tag, 'editor-stop-failed', { pool: slot.pool, machine: slot.machine, port: slot.port, done }); } catch { /* the order is gone */ }
        out.push(t('{tag}: kept {pool} port {port} on {machine}: {done}; trying again each pass', { tag: slot.tag, pool: slot.pool, port: slot.port, machine: slot.machine, done }));
      }
      continue;
    }
    updateStateJson<EditorSlot[]>(project, SLOTS, [], slots => slots.filter(s => !sameSlot(s, slot!)));
    try { orders.record(slot.tag, 'editor-released', { pool: slot.pool, machine: slot.machine, port: slot.port, run: slot.run ?? null, done }); } catch { /* the order is gone */ }
    out.push(t('{tag}: gave back {pool} port {port} on {machine} ({done})', { tag: slot.tag, pool: slot.pool, port: slot.port, machine: slot.machine, done }));
  }
  return out;
}

/** The slots with whether their editor is up: a local one is asked over MCP; a remote one shows what its run's state file said. */
export async function editorStatus(project: ProjectConfig): Promise<(EditorSlot & { up?: boolean; pids?: number[]; state?: string })[]> {
  return Promise.all(editorSlots(project).map(async s => {
    if (!s.spec) return s;
    let state: string | undefined;
    try { state = s.spec.state_file && existsSync(s.spec.state_file) ? JSON.parse(readFileSync(s.spec.state_file, 'utf8')).state : undefined; } catch { /* unreadable */ }
    return { ...s, up: await answers(s.url, 3000), pids: findEditors(s.spec), ...(state ? { state } : {}) };
  }));
}

/** What the worker is told about its editor. */
export function editorPrompt(slot: EditorSlot, pool: EditorPool): string {
  return [
    '', `## The editor of this run`, '',
    `This run has its own editor on port ${slot.port} of ${slot.machine}, opened on your worktree, with an MCP server at ${slot.url}. You reach it as the MCP server \`${pool.mcp_name}\` (its tools list the editor's toolsets; describe a toolset before calling it). Alba started it before you and stops it when the run ends.`,
    '',
    'The editor locks the game\'s binaries. Before a C++ build, stop it; after the build, start it again (same port, same URL; start waits until the MCP server answers):',
    '', '    node .alba/bin/editor.mjs stop', '    <the build>', '    node .alba/bin/editor.mjs start', '',
    '`node .alba/bin/editor.mjs status` says whether it is up; its log is `.alba/editor.log`. Never start another editor yourself, and never stop one that is not yours.', '',
  ].join('\n');
}
