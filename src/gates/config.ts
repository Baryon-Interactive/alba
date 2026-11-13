import type { ProjectConfig } from '../config.ts';
import { relativePath } from '../design/files.ts';

export type GateValue = { json_pointer: string; file?: string } | { regex: string; group: number };
export interface NightlyGate {
  name: string;
  argv: string[];
  cwd?: string;
  timeout_minutes: number;
  uses?: string[];
  kind?: string;
  result?: { pass: { json_pointer: string; file?: string; equals?: string | number | boolean | null } | { regex: string }; value?: GateValue };
}
export interface GatesConfig { nightly: NightlyGate[]; window: string; only_if_merged: boolean; worktree_timeout_minutes: number }
export const DEFAULT_WORKTREE_TIMEOUT_MINUTES = 30;

export function gatesConfig(raw: unknown, project: ProjectConfig): GatesConfig {
  const fail = (reason: string): never => { throw new Error(`gates: ${reason}`); };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !v.includes('\0');
  const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) fail('unknown field.'); };
  const pointer = (v: unknown) => typeof v === 'string' && (v === '' || v.startsWith('/')) && !/~(?:[^01]|$)/.test(v);
  const regex = (v: unknown) => { if (!text(v)) fail('regex must be nonempty.'); try { new RegExp(v as string); } catch { fail('invalid regex.'); } };
  const reader = (v: unknown, pass: boolean) => {
    if (!obj(v)) fail('result reader must be an object.');
    const r = v as Record<string, unknown>;
    if ('json_pointer' in r) {
      keys(r, ['json_pointer', 'file', ...(pass ? ['equals'] : [])]);
      if (!pointer(r.json_pointer)) fail('invalid JSON pointer.');
      if (r.file !== undefined && (typeof r.file !== 'string' || !relativePath(r.file))) fail('result file must stay inside cwd.');
      if ('equals' in r && r.equals !== null && !['string', 'number', 'boolean'].includes(typeof r.equals)) fail('equals must be a JSON scalar.');
      if (typeof r.equals === 'number' && !Number.isFinite(r.equals)) fail('equals must be finite.');
    } else {
      keys(r, ['regex', ...(pass ? [] : ['group'])]); regex(r.regex);
      if (!pass && (!Number.isSafeInteger(r.group) || (r.group as number) < 0)) fail('value group must be a nonnegative integer.');
    }
  };
  if (!obj(raw)) fail('expected a mapping.');
  const block = raw as Record<string, unknown>;
  keys(block, ['nightly', 'window', 'only_if_merged', 'worktree_timeout_minutes']);
  const checkout = block.worktree_timeout_minutes ?? DEFAULT_WORKTREE_TIMEOUT_MINUTES;
  if (typeof checkout !== 'number' || !Number.isFinite(checkout) || checkout <= 0 || checkout * 60000 > 2147483647) fail('worktree_timeout_minutes must be positive and fit a process timer.');
  const window = block.window ?? '01:00-06:00';
  if (typeof window !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(window) || window.slice(0, 5) === window.slice(6)) fail('window must be a nonempty HH:MM-HH:MM local time range.');
  if (block.only_if_merged !== undefined && typeof block.only_if_merged !== 'boolean') fail('only_if_merged must be boolean.');
  if (!Array.isArray(block.nightly)) fail('nightly must be a list.');
  const names = new Set<string>();
  for (const item of block.nightly as unknown[]) {
    if (!obj(item)) fail('each nightly gate must be a mapping.');
    const g = item as Record<string, unknown>;
    keys(g, ['name', 'argv', 'cwd', 'timeout_minutes', 'uses', 'kind', 'result']);
    if (!text(g.name) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(g.name) || names.has(g.name)) fail('gate names must be unique simple identifiers.');
    names.add(g.name as string);
    if (!Array.isArray(g.argv) || !text(g.argv[0]) || g.argv.some(a => typeof a !== 'string' || a.includes('\0'))) fail('argv must be a nonempty argument vector.');
    if (typeof g.timeout_minutes !== 'number' || !Number.isFinite(g.timeout_minutes) || g.timeout_minutes <= 0 || g.timeout_minutes * 60000 > 2147483647) fail('timeout_minutes must be positive and fit a process timer.');
    if (g.cwd !== undefined && (typeof g.cwd !== 'string' || (g.cwd !== '.' && !relativePath(g.cwd)))) fail('cwd must stay inside the project.');
    if (g.uses !== undefined && (!Array.isArray(g.uses) || g.uses.some(r => !text(r) || !Object.hasOwn(project.resources ?? {}, r)))) fail('uses must name declared resources.');
    if (g.kind !== undefined && (!text(g.kind) || !Object.hasOwn(project.dispatch.caps, g.kind))) fail('kind must name a configured cap.');
    if (g.result !== undefined) {
      if (!obj(g.result)) fail('result must be a mapping.');
      const r = g.result as Record<string, unknown>; keys(r, ['pass', 'value']); reader(r.pass, true);
      if (r.value !== undefined) reader(r.value, false);
    }
  }
  return { nightly: block.nightly as NightlyGate[], window: window as string, only_if_merged: block.only_if_merged !== false, worktree_timeout_minutes: checkout as number };
}
