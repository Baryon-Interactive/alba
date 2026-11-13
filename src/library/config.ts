import path from 'node:path';
import { fail } from '../i18n.ts';

/**
 * The art library: questions to pick from, reference pictures and setting cards, quote and spend files, and the calls other tools made.
 * Every section is optional; without it the page of that part says what to add and shows nothing.
 * `dir` is relative to the project's `root` (the paths inside the files are too); `records` and `reuse_cache` are relative to the project file.
 */
export type LibraryFormat = 'alba';

/** Project-level pick sets: one YAML file per question in `dir`. `records`: the external tool's own record of choices, read only. */
export interface PicksConfig {
  dir: string;
  format: LibraryFormat;
  records?: string;
  /** The project's name in the external tool's records, when it is not this project's id. */
  project_id: string;
}

/** The reference board (`refs.yaml`), the setting cards (`settings/<id>.yaml`) and the notes of `compare/`, all in `dir`. */
export interface ArtConfig {
  dir: string;
  format: LibraryFormat;
  /** The external tool's record of confirmed setting texts (`settings.jsonl`), read only. */
  records?: string;
  /** A folder of pictures kept by another tool (by sha256 of the address); a picture found there is used without a download. Read only. */
  reuse_cache?: string;
  project_id: string;
}

/** Quote files (`<id>.yaml`) and spend files (`<id>.spend.yaml`) in `dir`. `records`: the external tool's approvals, read only. */
export interface CreditsConfig {
  dir: string;
  format: LibraryFormat;
  records?: string;
  project_id: string;
}

/**
 * A file in which another tool records its calls (an image generator, for example), one JSON object per line.
 * `fields` names the keys of a line; a call belongs to the project when its `cwd` or `out` path is under the project's root.
 */
export interface UsageLedgerConfig {
  id: string;
  file: string;
  format: 'jsonl';
  fields: { time: string; model: string; status: string; cwd?: string; out?: string };
  project_match: 'path';
  /** Values of `status` that count as a successful call. */
  ok_values: string[];
  /** Zone of a time without one (`local` by default: the machine's own). */
  timezone: 'local' | 'utc';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function section(raw: unknown, key: string, file: string, allowed: string[]): Record<string, unknown> {
  if (!isRecord(raw)) fail('{file}: "{key}" must be a mapping.', { file, key });
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "{key}": {keys}.', { file, key, keys: unknown.join(', ') });
  if (typeof raw.dir !== 'string' || !raw.dir.trim()) fail('{file}: "{key}.dir" must be a folder of the project.', { file, key });
  if (raw.format !== undefined && raw.format !== 'alba') fail('{file}: "{key}.format" must be "alba".', { file, key });
  return raw;
}

function optionalPath(raw: Record<string, unknown>, name: string, key: string, file: string, base: string): string | undefined {
  const v = raw[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim()) fail('{file}: "{key}.{name}" must be a path.', { file, key, name });
  return path.resolve(base, v.trim());
}

function projectId(raw: Record<string, unknown>, key: string, file: string, fallback: string): string {
  const v = raw.project_id;
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !v.trim()) fail('{file}: "{key}.project_id" must be a name.', { file, key });
  return v.trim();
}

export function validatePicks(raw: unknown, file: string, base: string, root: string, id: string): PicksConfig {
  const r = section(raw, 'picks', file, ['dir', 'format', 'records', 'project_id']);
  const records = optionalPath(r, 'records', 'picks', file, base);
  return { dir: path.resolve(root, (r.dir as string).trim()), format: 'alba', ...(records ? { records } : {}), project_id: projectId(r, 'picks', file, id) };
}

export function validateArt(raw: unknown, file: string, base: string, root: string, id: string): ArtConfig {
  const r = section(raw, 'art', file, ['dir', 'format', 'records', 'reuse_cache', 'project_id']);
  const records = optionalPath(r, 'records', 'art', file, base);
  const reuse = optionalPath(r, 'reuse_cache', 'art', file, base);
  return { dir: path.resolve(root, (r.dir as string).trim()), format: 'alba', ...(records ? { records } : {}), ...(reuse ? { reuse_cache: reuse } : {}), project_id: projectId(r, 'art', file, id) };
}

export function validateCredits(raw: unknown, file: string, base: string, root: string, id: string): CreditsConfig {
  const r = section(raw, 'credits', file, ['dir', 'format', 'records', 'project_id']);
  const records = optionalPath(r, 'records', 'credits', file, base);
  return { dir: path.resolve(root, (r.dir as string).trim()), format: 'alba', ...(records ? { records } : {}), project_id: projectId(r, 'credits', file, id) };
}

/** `usage_ledgers`, in the project file or in the workers file: relative paths are relative to that file. */
export function validateUsageLedgers(raw: unknown, file: string, base: string): UsageLedgerConfig[] {
  if (!Array.isArray(raw)) fail('{file}: "usage_ledgers" must be a list.', { file });
  const ids = new Set<string>();
  return raw.map((item, i) => {
    const at = `usage_ledgers[${i}]`;
    if (!isRecord(item)) fail('{file}: "{at}" must be a mapping.', { file, at });
    const unknown = Object.keys(item).filter(k => !['id', 'file', 'format', 'fields', 'project_match', 'ok_values', 'timezone'].includes(k));
    if (unknown.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: unknown.join(', ') });
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.id)) fail('{file}: "{at}.id" must be letters, digits, "-" and "_".', { file, at });
    if (ids.has(item.id)) fail('{file}: usage ledger id "{id}" appears twice.', { file, id: item.id });
    ids.add(item.id);
    if (typeof item.file !== 'string' || !item.file.trim()) fail('{file}: "{at}.file" must be the path of the ledger.', { file, at });
    if (item.format !== undefined && item.format !== 'jsonl') fail('{file}: "{at}.format" must be "jsonl".', { file, at });
    if (item.project_match !== undefined && item.project_match !== 'path') fail('{file}: "{at}.project_match" must be "path".', { file, at });
    if (!isRecord(item.fields)) fail('{file}: "{at}.fields" must name the keys of a line: time, model, status and cwd and/or out.', { file, at });
    const f = item.fields;
    const unknownFields = Object.keys(f).filter(k => !['time', 'model', 'status', 'cwd', 'out'].includes(k));
    if (unknownFields.length) fail('{file}: unknown key(s) under "{at}.fields": {keys}.', { file, at, keys: unknownFields.join(', ') });
    for (const k of ['time', 'model', 'status']) if (typeof f[k] !== 'string' || !(f[k] as string).trim()) fail('{file}: "{at}.fields.{k}" must be a key of a line.', { file, at, k });
    for (const k of ['cwd', 'out']) if (f[k] !== undefined && (typeof f[k] !== 'string' || !(f[k] as string).trim())) fail('{file}: "{at}.fields.{k}" must be a key of a line.', { file, at, k });
    if (f.cwd === undefined && f.out === undefined) fail('{file}: "{at}.fields" needs "cwd" or "out": a call is attributed to a project by its folder.', { file, at });
    let ok = ['ok', 'succeeded', 'success'];
    if (item.ok_values !== undefined) {
      if (!Array.isArray(item.ok_values) || !item.ok_values.length || item.ok_values.some(v => typeof v !== 'string')) fail('{file}: "{at}.ok_values" must be a list of words.', { file, at });
      ok = (item.ok_values as string[]).map(v => v.toLowerCase());
    }
    if (item.timezone !== undefined && item.timezone !== 'local' && item.timezone !== 'utc') fail('{file}: "{at}.timezone" must be "local" or "utc".', { file, at });
    return {
      id: item.id, file: path.resolve(base, item.file.trim()), format: 'jsonl' as const, project_match: 'path' as const, ok_values: ok,
      timezone: (item.timezone as 'local' | 'utc' | undefined) ?? 'local',
      fields: { time: (f.time as string).trim(), model: (f.model as string).trim(), status: (f.status as string).trim(), ...(f.cwd ? { cwd: (f.cwd as string).trim() } : {}), ...(f.out ? { out: (f.out as string).trim() } : {}) },
    };
  });
}
