import { UserError } from '../i18n.ts';
import type { ResourceConfig } from '../config.ts';

/**
 * A pool of game editors a run can have for itself (`editors.<name>` in alba.yaml): an editor started on the order's worktree with an
 * MCP server on a fixed port of the run's machine, attached to the worker, and stopped when the run ends. The pool's name is also a
 * resource: an order asks for an editor with `uses: [<name>]` (or the resource's `match`).
 */
export interface EditorPool {
  name: string;
  /** The editor program, and its arguments with `{worktree}`, `{port}` and `{log}`. */
  program: string;
  args: string[];
  /** The MCP endpoint, with `{port}` (streamable HTTP). */
  url: string;
  /** The MCP server's name for the worker (`mcp__<name>__...`). */
  mcp_name: string;
  /** How long the editor may take until its MCP server answers `initialize`. */
  ready_minutes: number;
  /** Other resources each editor holds while it runs (for example the project's editor-build slots). */
  holds: string[];
  /** Skills a run with this editor gets (names in the skill registry, e.g. unreal-mcp-editor). */
  skills: string[];
  /** The kind cap each editor counts against (for example `ue`): an order with an editor counts there whatever its kind. */
  cap?: string;
  /** The machines with editors: their ports (one editor per port), and what differs there. */
  machines: Record<string, EditorMachine>;
  /** A step run in the worktree before the editor starts (for example compiling the game's C++ module in a new worktree). */
  prepare?: EditorPrepare;
}
/**
 * `editors.<pool>.prepare`: a command run in the order's worktree, on the run's machine, before its editor starts. It is skipped
 * when every `skip_if_newer.outputs` path exists and is newer than every file under `skip_if_newer.inputs`; it is tried again
 * after `retry_seconds` when it ends with one of `retry_exit_codes`, at most `retries` times.
 */
export interface EditorPrepare {
  command: string[];
  skip_if_newer?: { outputs: string[]; inputs: string[] };
  retry_exit_codes: number[];
  retries: number;
  retry_seconds: number;
  timeout_minutes: number;
}
export interface EditorMachine {
  ports: number[];
  /** The editor program on that machine, when it is installed elsewhere. */
  program?: string;
  /** Start the editor in the desktop session of the user logged on (a remote Windows host reached over SSH has none of its own). */
  desktop?: boolean;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks `editors`; declares each pool as a resource (one slot per port) unless the project declares it itself. */
export function validateEditors(raw: unknown, file: string, resources: Record<string, ResourceConfig> | undefined, caps: Record<string, number>): { editors: Record<string, EditorPool>; resources: Record<string, ResourceConfig> } {
  const fail = (message: string): never => { throw new UserError(`${file}: ${message}`); };
  if (!record(raw)) fail('"editors" must map a pool name to its editor, e.g. { ue-editor: { program, args, url, machines } }.');
  const editors: Record<string, EditorPool> = {};
  const out: Record<string, ResourceConfig> = { ...resources };
  const ports = new Map<string, string>();
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const at = `editors.${name}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) fail(`"${at}": a pool name of letters, digits, "_" and "-".`);
    if (!record(v)) return fail(`"${at}" must be a mapping with program, args, url and machines.`);
    const extra = Object.keys(v).filter(k => !['program', 'args', 'url', 'mcp_name', 'ready_minutes', 'holds', 'cap', 'skills', 'machines', 'prepare'].includes(k));
    if (extra.length) fail(`"${at}": unknown key(s): ${extra.join(', ')}.`);
    if (typeof v.program !== 'string' || !v.program.trim()) fail(`"${at}.program" must be the editor program.`);
    if (!Array.isArray(v.args) || v.args.some(a => typeof a !== 'string')) fail(`"${at}.args" must be a list of strings ({worktree}, {port}, {log}).`);
    const args = v.args as string[];
    if (!args.some(a => a.includes('{port}'))) fail(`"${at}.args" must pass {port} to the editor (its MCP port).`);
    if (typeof v.url !== 'string' || !/^https?:\/\/.*\{port\}/.test(v.url)) fail(`"${at}.url" must be the MCP endpoint with {port}, e.g. http://127.0.0.1:{port}/mcp.`);
    const mcp = v.mcp_name ?? 'unreal';
    if (typeof mcp !== 'string' || !/^[A-Za-z0-9_-]+$/.test(mcp)) fail(`"${at}.mcp_name" must be a server name of letters, digits, "_" and "-".`);
    const ready = v.ready_minutes ?? 10;
    if (typeof ready !== 'number' || !(ready > 0) || ready > 120) fail(`"${at}.ready_minutes" must be minutes above 0, at most 120.`);
    const skills = v.skills ?? [];
    if (!Array.isArray(skills) || skills.some(s => typeof s !== 'string' || !s.trim())) fail(`"${at}.skills" must be a list of skill names.`);
    const holds = v.holds ?? [];
    if (!Array.isArray(holds) || holds.some(h => typeof h !== 'string')) fail(`"${at}.holds" must be a list of resource names.`);
    for (const h of holds as string[]) if (!resources?.[h]) fail(`"${at}.holds": "${h}" is not a resource under "resources".`);
    if (v.cap !== undefined && (typeof v.cap !== 'string' || !Object.hasOwn(caps, v.cap))) fail(`"${at}.cap" must be a cap under "dispatch.caps" (${Object.keys(caps).join(', ') || 'none'}).`);
    if (!record(v.machines) || !Object.keys(v.machines).length) return fail(`"${at}.machines" must map machine ids to their ports, e.g. { gpu-box: { ports: [8101, 8102] } }.`);
    const machines: Record<string, EditorMachine> = {};
    for (const [machine, m] of Object.entries(v.machines)) {
      const mat = `${at}.machines.${machine}`;
      if (!record(m)) return fail(`"${mat}" must be a mapping with ports.`);
      const extraM = Object.keys(m).filter(k => !['ports', 'program', 'desktop'].includes(k));
      if (extraM.length) fail(`"${mat}": unknown key(s): ${extraM.join(', ')}.`);
      if (!Array.isArray(m.ports) || !m.ports.length || m.ports.some(p => !Number.isInteger(p) || (p as number) < 1024 || (p as number) > 65535)) fail(`"${mat}.ports" must be a list of ports from 1024 to 65535.`);
      for (const p of m.ports as number[]) {
        const key = `${machine}:${p}`;
        if (ports.has(key)) fail(`"${mat}.ports": ${p} is also a port of ${ports.get(key)}.`);
        ports.set(key, `editors.${name}`);
      }
      if (m.program !== undefined && (typeof m.program !== 'string' || !m.program.trim())) fail(`"${mat}.program" must be the editor program on that machine.`);
      if (m.desktop !== undefined && typeof m.desktop !== 'boolean') fail(`"${mat}.desktop" must be true or false.`);
      machines[machine] = { ports: m.ports as number[], ...(m.program ? { program: (m.program as string).trim() } : {}), ...(m.desktop ? { desktop: true } : {}) };
    }
    const prepare = v.prepare === undefined ? undefined : validatePrepare(v.prepare, `${at}.prepare`, fail);
    editors[name] = { name, program: (v.program as string).trim(), args, url: v.url as string, mcp_name: mcp as string, ready_minutes: ready as number, holds: holds as string[], skills: (skills as string[]).map(s => s.trim()), ...(v.cap ? { cap: v.cap as string } : {}), machines, ...(prepare ? { prepare } : {}) };
    const slots = Object.values(machines).reduce((n, m) => n + m.ports.length, 0);
    if (out[name]) { if (out[name]!.slots > slots) fail(`"resources.${name}" has ${out[name]!.slots} slots; the editor pool has ${slots} ports.`); }
    else out[name] = { slots, exclusive: false, blocks: [], lease_minutes: 480, note: `editor pool ${name}` };
  }
  return { editors, resources: out };
}

/** Checks `editors.<pool>.prepare`: a command (a list, or a mapping with `command`), and how it is skipped and tried again. */
function validatePrepare(raw: unknown, at: string, fail: (message: string) => never): EditorPrepare {
  const v = Array.isArray(raw) ? { command: raw } : raw;
  if (!record(v)) return fail(`"${at}" must be a command list, or a mapping with command, skip_if_newer, retry_exit_codes, retries, retry_seconds and timeout_minutes.`);
  const extra = Object.keys(v).filter(k => !['command', 'skip_if_newer', 'retry_exit_codes', 'retries', 'retry_seconds', 'timeout_minutes'].includes(k));
  if (extra.length) fail(`"${at}": unknown key(s): ${extra.join(', ')}.`);
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(a => typeof a === 'string' && a.trim() !== '');
  if (!strings(v.command) || !v.command.length) fail(`"${at}.command" must be the program and its arguments, e.g. [python, tools/build_ue.py] ({worktree} may be used).`);
  let skip: EditorPrepare['skip_if_newer'];
  if (v.skip_if_newer !== undefined) {
    const k = v.skip_if_newer;
    // Paths in the worktree: relative, and never out of it.
    const inside = (x: unknown): x is string[] => strings(x) && x.length > 0 && x.every(p => !/^([A-Za-z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'));
    if (!record(k) || Object.keys(k).some(x => x !== 'outputs' && x !== 'inputs') || !inside(k.outputs) || !inside(k.inputs)) fail(`"${at}.skip_if_newer" must be { outputs: [...], inputs: [...] }: files or folders in the worktree, relative to it.`);
    skip = { outputs: (k as { outputs: string[] }).outputs, inputs: (k as { inputs: string[] }).inputs };
  }
  const codes = v.retry_exit_codes ?? [];
  if (!Array.isArray(codes) || codes.some(c => !Number.isInteger(c) || c === 0)) fail(`"${at}.retry_exit_codes" must be a list of exit codes other than 0.`);
  const whole = (x: unknown, key: string, fallback: number, min: number, max: number): number => {
    const n = x ?? fallback;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) fail(`"${at}.${key}" must be a whole number from ${min} to ${max}.`);
    return n as number;
  };
  return {
    command: (v.command as string[]).map(a => a.trim()), ...(skip ? { skip_if_newer: skip } : {}), retry_exit_codes: codes as number[],
    retries: whole(v.retries, 'retries', 2, 0, 10), retry_seconds: whole(v.retry_seconds, 'retry_seconds', 30, 0, 600), timeout_minutes: whole(v.timeout_minutes, 'timeout_minutes', 60, 1, 600),
  };
}
