import { isMap, isSeq, parse, type Document } from 'yaml';
import { fail, t, UserError } from '../i18n.ts';
import { assign, editYaml, EditRefused, findItem, plainAt, type EditOutcome } from '../yamledit.ts';
import type { Orders } from '../orders/service.ts';
import { loadWorkers, validateWorkers } from './config.ts';

/** The keys of a worker the console may set one by one (the rest goes through the YAML editor). */
export const EDITABLE_FIELDS = ['notes', 'capabilities', 'model', 'pricing', 'max_tokens_per_run', 'max_minutes_per_run', 'max_usd_per_run', 'trip_after_failures', 'trip_minutes', 'cost', 'concurrency', 'daily_runs', 'enabled', 'aliases', 'disabled_when', 'daily_cap_usd', 'model_family', 'on_limit', 'rotate_paid', 'max_resumes', 'resume_backoff_minutes', 'route', 'quota', 'price', 'skills_mount', 'paid', 'card_only'] as const;

const WORKER_KEYS = ['notes', 'capabilities', 'model', 'pricing', 'max_tokens_per_run', 'max_minutes_per_run', 'max_usd_per_run', 'trip_after_failures', 'trip_minutes', 'id', 'engine', 'route', 'paid', 'concurrency', 'daily_runs', 'aliases', 'quota', 'enabled', 'disabled_when', 'card_only', 'launch', 'price', 'daily_cap_usd', 'cost', 'skills_mount', 'model_family', 'on_limit', 'rotate_paid', 'max_resumes', 'resume_backoff_minutes'];

const SECRET_PATTERNS: RegExp[] = [/\bsk-[A-Za-z0-9_-]{10,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[A-Za-z0-9_-]{20,}/, /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s{}"']{8,}/i];

/** Does this text look like a key? A known key shape, or one long random-looking token (mixed case and digits, no path or placeholder characters). */
export function looksLikeSecret(value: string, loose: boolean): boolean {
  if (SECRET_PATTERNS.some(p => p.test(value))) return true;
  return loose && /^[A-Za-z0-9_+=-]{32,}$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** Refuses a worker whose launch carries what looks like a key: in `env` values, and known key shapes in `args`. */
export function checkNoSecrets(worker: Record<string, unknown>): void {
  const launch = worker.launch;
  if (typeof launch !== 'object' || launch === null) return;
  const l = launch as Record<string, unknown>;
  const found: { field: string; message: string }[] = [];
  const message = (what: string) => t('{what} looks like a key. Keys are not written in the workers file: use a command that reads the key from a file (for example the provider\'s auth.command).', { what });
  if (typeof l.env === 'object' && l.env !== null) {
    for (const [name, v] of Object.entries(l.env as Record<string, unknown>)) if (typeof v === 'string' && looksLikeSecret(v, true)) found.push({ field: `launch.env.${name}`, message: message(`launch.env.${name}`) });
  }
  if (Array.isArray(l.args)) l.args.forEach((a, i) => { if (typeof a === 'string' && looksLikeSecret(a, false)) found.push({ field: `launch.args[${i}]`, message: message(`launch.args[${i}]`) }); });
  if (found.length) throw new EditRefused(found[0].message, found);
}

/** Validates the text of a whole workers file as `loadWorkers` would, turning the error into a refusal with the field when it names one. */
export function validateWorkersText(text: string, file: string, checkWorker?: string): void {
  let raw: unknown;
  try { raw = parse(text); } catch (e) { throw new EditRefused(t('{file} is not valid YAML: {error}', { file, error: (e as Error).message.split('\n')[0] })); }
  const workers = (raw as { workers?: unknown })?.workers;
  if (Array.isArray(workers)) for (const w of workers) if (typeof w === 'object' && w !== null && (checkWorker === undefined || (w as { id?: unknown }).id === checkWorker)) checkNoSecrets(w as Record<string, unknown>);
  try { validateWorkers(raw, file); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    const m = e.message;
    const quoted = [...m.matchAll(/"([A-Za-z_][\w.-]*)"/g)].map(x => x[1]);
    const field = quoted.find(q => WORKER_KEYS.includes(q)) ?? /workers\[\d+\]: (\w+)/.exec(m)?.[1];
    throw new EditRefused(m, [{ ...(field ? { field } : {}), message: m }]);
  }
}

export interface WorkerOp { path: string[]; value: unknown }

const idOk = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);

/** Applies field changes to one worker of the file. `ops` with one-segment paths replace that field (a mapping is compared key by key, so the comments of what stays are kept); longer paths change one key inside. */
export function editWorker(file: string, id: string, ops: WorkerOp[], options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!ops.length) fail('Nothing to change.');
  return editYaml(file, doc => {
    const item = findItem(doc, ['workers'], 'id', id);
    if (!item) fail('No worker "{id}" in {file}.', { id, file });
    const changed: string[] = [];
    for (const op of ops) {
      if (op.path[0] === 'id') fail('A worker\'s id cannot be changed here: add a copy under the new id instead.');
      const at = ['workers', item.index, ...op.path];
      changed.push(...assign(doc, at, op.value, plainAt(doc, at)).map(n => n.replace(`workers.${item.index}.`, '')));
    }
    return changed;
  }, text => validateWorkersText(text, file, id), options);
}

/** The worker's own YAML (without the list dash), as written, comments inside it kept. */
export function workerYaml(file: string, id: string): string {
  let found: string | undefined;
  editYaml(file, doc => {
    const item = findItem(doc, ['workers'], 'id', id);
    if (!item) fail('No worker "{id}" in {file}.', { id, file });
    const { Document: D } = { Document: doc.constructor as new (v: unknown) => Document };
    const sub = new D(item.map.clone());
    found = sub.toString({ lineWidth: 0 }).trimEnd() + '\n';
    return [];
  }, () => undefined);
  return found!;
}

/** Replaces what the worker is by the YAML given (the "advanced" editor): keys that are not in it are removed, keys that did not change are left as they were. */
export function editWorkerYaml(file: string, id: string, yaml: string, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  let next: unknown;
  try { next = parse(yaml); } catch (e) { throw new EditRefused(t('The YAML is not valid: {error}', { error: (e as Error).message.split('\n')[0] })); }
  if (typeof next !== 'object' || next === null || Array.isArray(next)) throw new EditRefused(t('The worker must be a mapping (key: value lines).'));
  const given = next as Record<string, unknown>;
  if (given.id !== undefined && given.id !== id) throw new EditRefused(t('A worker\'s id cannot be changed here: add a copy under the new id instead.'), [{ field: 'id', message: t('A worker\'s id cannot be changed here: add a copy under the new id instead.') }]);
  return editYaml(file, doc => {
    const item = findItem(doc, ['workers'], 'id', id);
    if (!item) fail('No worker "{id}" in {file}.', { id, file });
    const old = plainAt(doc, ['workers', item.index]) as Record<string, unknown>;
    const changed: string[] = [];
    for (const key of Object.keys(old)) if (key !== 'id' && !(key in given)) { doc.deleteIn(['workers', item.index, key]); changed.push(key); }
    for (const [key, v] of Object.entries(given)) if (key !== 'id') changed.push(...assign(doc, ['workers', item.index, key], v, old[key]).map(n => n.replace(`workers.${item.index}.`, '')));
    return changed;
  }, text => validateWorkersText(text, file, id), options);
}

/** A new worker: from `yaml`, or a copy of `copyFrom` with `set` applied. The new worker goes at the end of the list (or right after the one it was copied from). */
export function addWorker(file: string, input: { id: string; copyFrom?: string; set?: Record<string, unknown>; yaml?: string }, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!idOk(input.id)) throw new EditRefused(t('A worker id is letters, digits, "." "_" "-".'), [{ field: 'id', message: t('A worker id is letters, digits, "." "_" "-".') }]);
  return editYaml(file, doc => {
    const list = doc.get('workers', true);
    if (!isSeq(list)) fail('{file}: "workers" must be a non-empty list.', { file });
    if (findItem(doc, ['workers'], 'id', input.id)) throw new EditRefused(t('There is a worker "{id}" already.', { id: input.id }), [{ field: 'id', message: t('There is a worker "{id}" already.', { id: input.id }) }]);
    let base: Record<string, unknown> = {};
    let after = list.items.length - 1;
    if (input.copyFrom) {
      const from = findItem(doc, ['workers'], 'id', input.copyFrom);
      if (!from) fail('No worker "{id}" in {file}.', { id: input.copyFrom, file });
      base = JSON.parse(JSON.stringify(plainAt(doc, ['workers', from.index]))) as Record<string, unknown>;
      after = from.index;
    }
    if (input.yaml !== undefined) {
      let v: unknown;
      try { v = parse(input.yaml); } catch (e) { throw new EditRefused(t('The YAML is not valid: {error}', { error: (e as Error).message.split('\n')[0] })); }
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new EditRefused(t('The worker must be a mapping (key: value lines).'));
      base = v as Record<string, unknown>;
    }
    for (const [k, v] of Object.entries(input.set ?? {})) { if (v === null || v === undefined) delete base[k]; else base[k] = v; }
    const worker = { id: input.id, ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'id')) };
    const node = doc.createNode(worker);
    if (isMap(node)) node.spaceBefore = true;
    list.items.splice(after + 1, 0, node);
    return ['*'];
  }, text => validateWorkersText(text, file, input.id), options);
}

/**
 * Takes a worker out of the workers file. Refused while `busy` names something that still uses it (an open run, an order pinned
 * to it, a route or worker group naming it): those must be moved first, or the file would not load or a run would lose its worker.
 */
export function removeWorker(file: string, id: string, busy: readonly string[], options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (busy.length) throw new EditRefused(t('{id} is still in use: {what}.', { id, what: busy.join('; ') }));
  return editYaml(file, doc => {
    const found = findItem(doc, ['workers'], 'id', id);
    if (!found) fail('No worker "{id}" in {file}.', { id, file });
    (doc.get('workers', true) as { items: unknown[] }).items.splice(found!.index, 1);
    return [`workers.${id}`];
  }, text => validateWorkersText(text, file), options);
}

/** `capabilities=[shell,edit]` style arguments of `alba workers set`: the value is read as YAML (`3`, `false`, `[a, b]`, `{ build: 3 }`, `null` removes the key). */
export function parseSetArgs(args: readonly string[]): WorkerOp[] {
  if (!args.length) fail('Usage: alba workers set <id> <key>=<value> ... (for example capabilities=[shell,edit] concurrency=4 enabled=false)');
  return args.map(a => {
    const eq = a.indexOf('=');
    if (eq <= 0) fail('"{arg}" is not key=value.', { arg: a });
    const path = a.slice(0, eq).split('.').filter(Boolean);
    let value: unknown;
    try { value = parse(a.slice(eq + 1)); } catch { value = a.slice(eq + 1); }
    return { path, value: value === null ? undefined : value };
  });
}

/** After a write: the file as the rest of the program will read it. */
export const reloadWorkers = (file: string) => loadWorkers(file);

/** The `set` object of a request as edits of single fields (`null` removes a key); only the fields the console edits one by one are accepted, the rest goes through `yaml`. */
export function opsFromSet(set: Record<string, unknown>): WorkerOp[] {
  const bad = Object.keys(set).filter(k => !(EDITABLE_FIELDS as readonly string[]).includes(k));
  if (bad.length) throw new EditRefused(t('Not editable one by one: {keys} (use the YAML of the worker for those).', { keys: bad.join(', ') }), bad.map(field => ({ field, message: t('Not editable one by one: {keys} (use the YAML of the worker for those).', { keys: field }) })));
  return Object.entries(set).map(([key, value]) => ({ path: [key], value: value === null ? undefined : value }));
}

/** Writes the `workers.edited` entry of the project's event log: which worker, which fields, and (through the log's own `by`) who. */
export function recordWorkerEdit(orders: Orders, id: string, out: EditOutcome, file: string): void {
  if (out.dryRun || !out.changed.length) return;
  orders.record('*', 'workers.edited', { worker: id, fields: out.changed, file, ...(out.backup ? { backup: out.backup } : {}) });
}
