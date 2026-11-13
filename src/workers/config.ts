export const CAPABILITIES = ['shell', 'edit', 'git', 'vision', 'web', 'long-context', 'long-run', 'windows', 'mcp', 'fast', 'cheap', 'strong-reasoning'] as const;
import { existsSync, readFileSync } from 'node:fs';
import { validateRoles, validateRouting, type Roles, type WorkerGroups } from '../roles/config.ts';
import path from 'node:path';
import { parse } from 'yaml';
import { fail } from '../i18n.ts';
import { loadSkillsConfig, type SkillsRegistryConfig } from '../skills/registry.ts';
import { validateUsageLedgers, type UsageLedgerConfig } from '../library/config.ts';

/** Where a worker's quota is read from. No secrets here: a command may read them from wherever it likes. */
export interface CommandQuota {
  type: 'command-json';
  command: string[];                 // program and arguments, run without a shell
  select?: { field: string; equals: string };   // which items of the output array belong to this source
  windows: string;                   // path to the windows list inside an item
  window_fields: { name: string; used: string; resets_at: string };   // used = percent used
  balance?: string;                  // path to a balance string such as "123.4 credits"
  timeout_seconds: number;
}
export interface StaticQuota {
  type: 'static';
  unlimited: boolean;
  windows: { name: string; used_percent: number; resets_at?: string }[];
  balance?: string;
}
/** A Codex subscription's windows, read from the session files Codex writes (`<codex_home>/sessions`); nothing is called. */
export interface CodexSessionsQuota {
  type: 'codex-sessions';
  codex_home?: string;               // absolute; default CODEX_HOME, else ~/.codex
}
export type QuotaConfig = CommandQuota | StaticQuota | CodexSessionsQuota;

export type DisabledRule =
  | { window_full: string; at: number }     // a window whose name matches (`*` allowed) is used up to `at` percent
  | { balance_drop: number };               // the balance fell by more than this since the previous reading

/**
 * How the tool starts this worker. Placeholders in args: {cwd} {prompt_file} {last_file} {model} {log} {git_dir} {worktree_git_dir} {session_id}.
 * No keys: a key may only be read by the program itself.
 * Engines that can continue a conversation list `session` arguments, spliced in where `args` has the entry `{session_args}`:
 * `new` starts a session under an id the tool chooses ({session_id}), `resume` continues the previous run's session.
 */
export interface LaunchTemplate {
  id: string;                        // recorded on each run instead of the command line
  program: string;
  args: string[];
  session?: { new: string[]; resume: string[] };
  model?: string;
  env: Record<string, string>;
  env_unset: string[];
}
/** Placeholders in the values of `launch.env`: the names of the skills put into the worktree, and them as `"name":"allow"` pairs (for a permission map). */
export const ENV_PLACEHOLDERS = ['skill_names', 'skill_allow', 'tunnel_port'];
export const PLACEHOLDERS = ['cwd', 'prompt_file', 'last_file', 'model', 'log', 'git_dir', 'worktree_git_dir', 'session_id', 'tunnel_port'] as const;

import type { Pricing } from '../usage/types.ts';
export interface WorkerConfig {
  host?: string;
  tunnel?: number;
  pricing?: Pricing;
  id: string;
  engine: string;
  route?: string;
  paid: boolean;
  concurrency: number;
  daily_runs?: number;
  capabilities: string[];
  notes?: string;
  model?: string;
  cost: 'included' | 'paid';          // inside a subscription window, or paid per use (default: `paid` when `paid: true`)
  model_family?: string;             // the model behind it, free text: workers that share it are shown as the same model in a different shell
  skills_mount?: string[];           // where skills are put in a worktree for this worker (default by engine)
  aliases: string[];                 // words in an order's worker text that mean this worker
  quota?: string;                    // name of an entry in quota_sources
  enabled: boolean;
  disabled_when: DisabledRule[];
  card_only: boolean;                // can only be offered as a card for a person to start
  launch?: LaunchTemplate;           // how to start it (absent for card-only workers)
  price?: { input_per_mtok?: number; output_per_mtok?: number; per_mtok?: number };   // US dollars per million tokens, to estimate cost when the engine prints none
  daily_cap_usd?: number;            // no more runs on this worker today once the day's cost reaches this
  on_limit?: 'wait' | 'rotate';      // a capacity error or a used-up quota window: resume on this worker later (wait, default) or hand the order to the next worker (rotate)
  rotate_paid?: boolean;             // with on_limit rotate: a capacity or quota ending may hand the order to a worker whose cost is paid (stored only when true)
  max_tokens_per_run?: number;       // stop at the next dispatcher pass once observed usage exceeds this
  max_resumes?: number;              // consecutive capacity resumes before failing (default 3)
  resume_backoff_minutes?: number[]; // waits before each resume; the last value repeats (default [1, 5, 15])
}

export interface WorkersFile {
  roles?: Roles;
  /** `routing.groups` of this file. */
  worker_groups?: WorkerGroups;
  /** `routing.avoid` of this file: workers no route chooses by itself. */
  routing_avoid?: string[];
  /** The file writes `routing` (otherwise its routes, if any, are the earlier `roles`). */
  uses_routing?: true;
  warnings?: string[];
  extraCapabilities?: string[];
  pricing?: Record<string, Pricing>;
  workers: WorkerConfig[];
  quota_sources: Record<string, QuotaConfig>;
  /** The skill registry: the `skills:` block of this file and a `skills.yaml` next to it. */
  skills?: SkillsRegistryConfig;
  /** : files in which other tools record their calls (an image generator, for example); the project file may list its own. */
  usage_ledgers?: UsageLedgerConfig[];
  file: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadWorkers(file: string): WorkersFile {
  if (!existsSync(file)) fail('Workers file not found: {file}', { file });
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { fail('{file} is not valid YAML: {error}', { file, error: (e as Error).message }); }
  return validateWorkers(raw, file);
}

export function validateWorkers(raw: unknown, file: string): WorkersFile {
  if (!isRecord(raw)) fail('{file}: the top level must be a mapping with "workers" (and optionally "quota_sources").', { file });
  const unknownTop = Object.keys(raw).filter(k => !['workers', 'quota_sources', 'skills', 'usage_ledgers', 'pricing', 'roles', 'routing'].includes(k));
  if (unknownTop.length) fail('{file}: unknown key(s): {keys}.', { file, keys: unknownTop.join(', ') });
  const sources: Record<string, QuotaConfig> = {};
  if (raw.quota_sources !== undefined) {
    if (!isRecord(raw.quota_sources)) fail('{file}: "quota_sources" must be a mapping of name to source.', { file });
    for (const [name, value] of Object.entries(raw.quota_sources)) sources[name] = validateQuota(value, `${file}: quota_sources.${name}`);
  }
  if (!Array.isArray(raw.workers) || !raw.workers.length) fail('{file}: "workers" must be a non-empty list.', { file });
  const ids = new Set<string>();
  const warnings: string[] = [];
  const workers = raw.workers.map((w, i) => {
    const worker = validateWorker(w, `${file}: workers[${i}]`);
    if (ids.has(worker.id)) fail('{file}: worker id "{id}" appears twice.', { file, id: worker.id });
    ids.add(worker.id);
    if (worker.quota && !sources[worker.quota]) fail('{where}: quota "{name}" is not defined in quota_sources.', { where: `${file}: worker "${worker.id}"`, name: worker.quota });
    return worker;
  });
  const pricing: Record<string, Pricing> = {};
  if (raw.pricing !== undefined) {
    if (!isRecord(raw.pricing)) fail('{where} must be a mapping.', { where: `${file}: pricing` });
    for (const [key, value] of Object.entries(raw.pricing)) pricing[key] = validatePricing(value, `${file}: pricing.${key}`);
  }
  const skills = loadSkillsConfig(file, raw.skills);
  const ledgers = raw.usage_ledgers === undefined ? undefined : validateUsageLedgers(raw.usage_ledgers, file, path.dirname(path.resolve(file)));
  return { workers, pricing, quota_sources: sources, warnings,
    extraCapabilities: [...new Set(workers.flatMap(w => w.capabilities).filter(c => !(CAPABILITIES as readonly string[]).includes(c)))],
    ...routingOf(raw, file), ...(skills ? { skills } : {}), ...(ledgers ? { usage_ledgers: ledgers } : {}), file };
}

/** The routes and worker groups of a file: `routing` (the current form) or `roles` (the earlier one), never both. */
export function routingOf(raw: Record<string, unknown>, file: string): { roles?: Roles; worker_groups?: WorkerGroups; routing_avoid?: string[]; uses_routing?: true } {
  if (raw.routing !== undefined && raw.roles !== undefined) fail('{file}: "roles" and "routing" are both set; routing replaces roles, keep one (alba routing migrate prints the routing for the roles you have).', { file });
  if (raw.routing !== undefined) { const r = validateRouting(raw.routing, file); return { roles: r.roles, uses_routing: true, ...(Object.keys(r.groups).length ? { worker_groups: r.groups } : {}), ...(r.avoid.length ? { routing_avoid: r.avoid } : {}) }; }
  return raw.roles !== undefined ? { roles: validateRoles(raw.roles, file) } : {};
}

function validateWorker(raw: unknown, where: string): WorkerConfig {
  if (!isRecord(raw)) fail('{where} must be a mapping.', { where });
  const known = ['capabilities', 'notes', 'model', 'id', 'engine', 'route', 'paid', 'concurrency', 'daily_runs', 'aliases', 'quota', 'enabled', 'disabled_when', 'card_only', 'launch', 'price', 'daily_cap_usd', 'cost', 'skills_mount', 'model_family', 'on_limit', 'rotate_paid', 'max_resumes', 'resume_backoff_minutes', 'pricing', 'max_tokens_per_run', 'host', 'tunnel'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
  const text = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined) { if (required) fail('{where}: "{key}" is required.', { where, key }); return undefined; }
    if (typeof v !== 'string' || !v.trim()) fail('{where}: "{key}" must be a non-empty string.', { where, key });
    return v.trim();
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') fail('{where}: "{key}" must be true or false.', { where, key });
    return v;
  };
  const whole = (key: string, fallback: number | undefined, min: number): number | undefined => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) fail('{where}: "{key}" must be a whole number >= {min}.', { where, key, min });
    return v;
  };
  const list = (key: string): string[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail('{where}: "{key}" must be a list of non-empty strings.', { where, key });
    return (v as string[]).map(x => x.trim());
  };
  const id = text('id', true)!;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('{where}: "id" must be lower-case letters, digits and "-".', { where });
  const engine = text('engine', true)!;
  const worker: WorkerConfig = {
    id, engine, paid: bool('paid', false), concurrency: whole('concurrency', 1, 1)!, capabilities: list('capabilities'), aliases: list('aliases'), cost: 'paid',
    enabled: bool('enabled', true), card_only: bool('card_only', engine === 'claude-session'), disabled_when: [],
  };
  worker.cost = worker.paid ? 'paid' : 'included';
  const notes = text('notes', false); if (notes) worker.notes = notes;
  const model = text('model', false); if (model) worker.model = model;
  if (raw.cost !== undefined) {
    if (raw.cost !== 'included' && raw.cost !== 'paid') fail('{where}: "cost" must be "included" (inside a subscription window) or "paid".', { where });
    worker.cost = raw.cost;
  }
  const mount = list('skills_mount');
  for (const m of mount) if (path.isAbsolute(m) || m.split(/[\/]/).includes('..')) fail('{where}: "skills_mount" entries are folders inside a worktree, "{m}" is not.', { where, m });
  if (mount.length) worker.skills_mount = mount;
  if (raw.on_limit !== undefined && raw.on_limit !== 'wait' && raw.on_limit !== 'rotate') fail('{where}: "on_limit" must be "wait" or "rotate".', { where });
  if (raw.on_limit !== undefined) worker.on_limit = raw.on_limit as 'wait' | 'rotate';
  if (raw.rotate_paid !== undefined && typeof raw.rotate_paid !== 'boolean') fail('{where}: "rotate_paid" must be true or false.', { where });
  if (raw.rotate_paid === true) worker.rotate_paid = true;
  if (raw.max_resumes !== undefined) {
    if (typeof raw.max_resumes !== 'number' || !Number.isInteger(raw.max_resumes) || raw.max_resumes < 0 || raw.max_resumes > 50) fail('{where}: "max_resumes" must be a whole number from 0 to 50.', { where });
    worker.max_resumes = raw.max_resumes;
  } else worker.max_resumes = 3;
  if (raw.resume_backoff_minutes !== undefined) {
    if (!Array.isArray(raw.resume_backoff_minutes) || !raw.resume_backoff_minutes.length || raw.resume_backoff_minutes.some(v => typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) fail('{where}: "resume_backoff_minutes" must be a non-empty list of positive whole numbers.', { where });
    worker.resume_backoff_minutes = [...raw.resume_backoff_minutes] as number[];
  } else worker.resume_backoff_minutes = [1, 5, 15];
  if (raw.host !== undefined) {
    if (typeof raw.host !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.host)) fail('{where}: "host" must be the id of a machine in the machine registry.', { where });
    worker.host = raw.host;
  }
  if (raw.tunnel !== undefined) {
    if (typeof raw.tunnel !== 'number' || !Number.isInteger(raw.tunnel) || raw.tunnel < 1 || raw.tunnel > 65535) fail('{where}: "tunnel" must be a port number on this machine.', { where });
    if (!worker.host) fail('{where}: "tunnel" requires "host".', { where });
    worker.tunnel = raw.tunnel;
  }
  if (raw.model_family !== undefined) {
    if (typeof raw.model_family !== 'string' || !raw.model_family.trim()) fail('{where}: "model_family" must be a short text, for example the model name.', { where });
    worker.model_family = raw.model_family.trim();
  }
  if (raw.launch !== undefined) {
    const l = raw.launch;
    const here = `${where}: launch`;
    if (!isRecord(l)) fail('{where} must be a mapping.', { where: here });
    const bad = Object.keys(l).filter(k => !['template', 'program', 'args', 'session', 'model', 'env', 'env_unset'].includes(k));
    if (bad.length) fail('{where}: unknown key(s): {keys}.', { where: here, keys: bad.join(', ') });
    if (typeof l.program !== 'string' || !l.program) fail('{where}: "program" is required.', { where: here });
    const strings = (v: unknown, at: string): string[] => {
      if (!Array.isArray(v) || v.some(a => typeof a !== 'string')) fail('{where}: "{key}" must be a list of strings.', { where: here, key: at });
      for (const a of v as string[]) for (const m of a.matchAll(/\{(\w+)\}/g)) {
        if (m[1] === 'engine_flags' && a === '{engine_flags}' && at === 'args' && worker.engine === 'codex-cli') continue;
        if (m[1] !== 'session_args' && !(PLACEHOLDERS as readonly string[]).includes(m[1])) fail('{where}: unknown placeholder {{name}} (allowed: {allowed}).', { where: here, name: m[1], allowed: PLACEHOLDERS.join(', ') });
      }
      return v as string[];
    };
    const args = strings(l.args, 'args');
    let session: LaunchTemplate['session'];
    if (l.session !== undefined) {
      if (!isRecord(l.session) || Object.keys(l.session).some(k => !['new', 'resume'].includes(k))) fail('{where}: "session" must have "new" and "resume" argument lists.', { where: here });
      session = { new: strings(l.session.new, 'session.new'), resume: strings(l.session.resume, 'session.resume') };
    }
    if (args.includes('{session_args}') !== (session !== undefined)) fail('{where}: "session" and the "{session_args}" entry in "args" go together.', { where: here });
    // codex-cli puts its own flags (--json, for the event log) right after "exec", or after the first argument when there is none (a
    // script that stands in for codex). A shell that runs a wrapper script would get the flag among its own arguments and stop at once
    // ("ended without a report block"), so such a template must say where the flags go.
    const shell = /^(powershell|pwsh|cmd|bash|sh|zsh)(\.exe)?$/i.test((l.program as string).split(/[\\/]/).pop() ?? '');
    if (worker.engine === 'codex-cli' && shell && !args.includes('{engine_flags}') && !args.includes('exec') && !(session && session.new.includes('exec') && session.resume.includes('exec'))) {
      fail('{where}: engine codex-cli adds "--json" right after "exec" in the arguments, and "program" is a shell with no "exec" in "args" (a wrapper script?): the shell would get "--json" as its own argument. Start codex itself with "exec" in "args", or put the entry "{engine_flags}" in "args" where the flags of codex go and have the wrapper pass them on to "codex exec".', { where: here });
    }
    const env = l.env === undefined ? {} : l.env;
    if (!isRecord(env) || Object.values(env).some(v => typeof v !== 'string')) fail('{where}: "env" must map names to strings.', { where: here });
    for (const v of Object.values(env) as string[]) for (const m of v.matchAll(/(?<!\$)\{(\w+)\}/g)) if (!ENV_PLACEHOLDERS.includes(m[1])) fail('{where}: unknown placeholder {{name}} in "env" (allowed: {allowed}).', { where: here, name: m[1], allowed: ENV_PLACEHOLDERS.join(', ') });
    const unset = l.env_unset === undefined ? [] : l.env_unset;
    if (!Array.isArray(unset) || unset.some(v => typeof v !== 'string')) fail('{where}: "env_unset" must be a list of names.', { where: here });
    worker.launch = {
      id: typeof l.template === 'string' && l.template ? l.template : worker.id, program: l.program, args, ...(session ? { session } : {}),
      ...(typeof l.model === 'string' ? { model: l.model } : {}), env: env as Record<string, string>, env_unset: unset as string[],
    };
  }
  const money = (v: unknown, key: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('{where}: "{key}" must be a number >= 0.', { where, key });
    return v;
  };
  if (raw.pricing !== undefined) worker.pricing = validatePricing(raw.pricing, `${where}: pricing`);
  if (raw.price !== undefined) {
    if (!isRecord(raw.price) || Object.keys(raw.price).some(k => !['input_per_mtok', 'output_per_mtok', 'per_mtok'].includes(k))) fail('{where}: "price" takes input_per_mtok and output_per_mtok, or per_mtok (US dollars per million tokens).', { where });
    const p = raw.price;
    worker.price = {};
    for (const k of ['input_per_mtok', 'output_per_mtok', 'per_mtok'] as const) if (p[k] !== undefined) worker.price[k] = money(p[k], `price.${k}`);
    if ((worker.price.input_per_mtok === undefined) !== (worker.price.output_per_mtok === undefined)) fail('{where}: "price" needs input_per_mtok and output_per_mtok together.', { where });
  }
  if (raw.daily_cap_usd !== undefined) worker.daily_cap_usd = money(raw.daily_cap_usd, 'daily_cap_usd');
  const route = text('route', false); if (route) worker.route = route;
  const tokenCap = whole('max_tokens_per_run', undefined, 1); if (tokenCap !== undefined) worker.max_tokens_per_run = tokenCap;
  const daily = whole('daily_runs', undefined, 0); if (daily !== undefined) worker.daily_runs = daily;
  const quota = text('quota', false); if (quota) worker.quota = quota;
  if (raw.disabled_when !== undefined) {
    if (!Array.isArray(raw.disabled_when)) fail('{where}: "disabled_when" must be a list of rules.', { where });
    worker.disabled_when = raw.disabled_when.map((r, i) => {
      const at = `${where}: disabled_when[${i}]`;
      if (!isRecord(r)) fail('{where} must be a mapping.', { where: at });
      const keys = Object.keys(r);
      if ('window_full' in r) {
        if (keys.some(k => !['window_full', 'at'].includes(k))) fail('{where}: allowed keys are window_full and at.', { where: at });
        if (typeof r.window_full !== 'string' || !r.window_full) fail('{where}: "window_full" must be a window name (`*` matches anything).', { where: at });
        const pct = r.at === undefined ? 100 : r.at;
        if (typeof pct !== 'number' || pct <= 0 || pct > 100) fail('{where}: "at" must be a percent in (0, 100].', { where: at });
        return { window_full: r.window_full, at: pct };
      }
      if ('balance_drop' in r) {
        if (keys.length !== 1) fail('{where}: balance_drop takes no other keys.', { where: at });
        if (typeof r.balance_drop !== 'number' || r.balance_drop < 0) fail('{where}: "balance_drop" must be a number >= 0.', { where: at });
        return { balance_drop: r.balance_drop };
      }
      return fail('{where}: a rule must be window_full or balance_drop.', { where: at });
    });
    if (worker.disabled_when.some(r => 'balance_drop' in r) && !worker.quota) fail('{where}: balance_drop needs a quota source.', { where });
    if (worker.disabled_when.some(r => 'window_full' in r) && !worker.quota) fail('{where}: window_full needs a quota source.', { where });
  }
  return worker;
}

function validateQuota(raw: unknown, where: string): QuotaConfig {
  if (!isRecord(raw)) fail('{where} must be a mapping.', { where });
  if (raw.type === 'static') {
    const unknown = Object.keys(raw).filter(k => !['type', 'unlimited', 'windows', 'balance'].includes(k));
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    const windows = raw.windows === undefined ? [] : raw.windows;
    if (!Array.isArray(windows)) fail('{where}: "windows" must be a list.', { where });
    return {
      type: 'static', unlimited: raw.unlimited === true, balance: typeof raw.balance === 'string' ? raw.balance : undefined,
      windows: windows.map((w, i) => {
        if (!isRecord(w) || typeof w.name !== 'string' || typeof w.used_percent !== 'number') fail('{where}: windows[{i}] needs "name" and a numeric "used_percent".', { where, i });
        return { name: w.name, used_percent: w.used_percent, ...(typeof w.resets_at === 'string' ? { resets_at: w.resets_at } : {}) };
      }),
    };
  }
  if (raw.type === 'command-json') {
    const unknown = Object.keys(raw).filter(k => !['type', 'command', 'select', 'windows', 'window_fields', 'balance', 'timeout_seconds'].includes(k));
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    if (!Array.isArray(raw.command) || !raw.command.length || raw.command.some(c => typeof c !== 'string')) fail('{where}: "command" must be a list: the program, then its arguments (no shell is used).', { where });
    const fields = isRecord(raw.window_fields) ? raw.window_fields : {};
    const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
    let select: CommandQuota['select'];
    if (raw.select !== undefined) {
      if (!isRecord(raw.select) || typeof raw.select.field !== 'string' || typeof raw.select.equals !== 'string') fail('{where}: "select" needs "field" and "equals" strings.', { where });
      select = { field: raw.select.field, equals: raw.select.equals };
    }
    const timeout = raw.timeout_seconds === undefined ? 60 : raw.timeout_seconds;
    if (typeof timeout !== 'number' || timeout <= 0) fail('{where}: "timeout_seconds" must be a positive number.', { where });
    return {
      type: 'command-json', command: raw.command as string[], select, windows: str(raw.windows, 'windows'),
      window_fields: { name: str(fields.name, 'name'), used: str(fields.used, 'used'), resets_at: str(fields.resets_at, 'resetsAt') },
      balance: typeof raw.balance === 'string' ? raw.balance : undefined, timeout_seconds: timeout,
    };
  }
  if (raw.type === 'codex-sessions') {
    const unknown = Object.keys(raw).filter(k => !['type', 'codex_home'].includes(k));
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    if (raw.codex_home !== undefined && (typeof raw.codex_home !== 'string' || !path.isAbsolute(raw.codex_home))) fail('{where}: "codex_home" must be an absolute folder (the CODEX_HOME the worker uses).', { where });
    return { type: 'codex-sessions', ...(typeof raw.codex_home === 'string' ? { codex_home: raw.codex_home } : {}) };
  }
  return fail('{where}: "type" must be "command-json", "static" or "codex-sessions".', { where });
}

function validatePricing(raw: unknown, where: string): Pricing {
  if (!isRecord(raw) || Object.keys(raw).some(k => !['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok', 'currency'].includes(k)) || typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency) || ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok'].some(k => typeof raw[k] !== 'number' || !Number.isFinite(raw[k]) || (raw[k] as number) < 0)) fail('Invalid pricing at {where}.', { where });
  return raw as unknown as Pricing;
}
