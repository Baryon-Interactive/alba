import type { ConfigEdit } from './api.ts';
import { numberField, same, sectionEdit } from './config-edit.ts';

type Values = Record<string, unknown>;
const record = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The `plugins` block of the project file as written there (from `GET /api/config`), with empty parts for what is not written. */
export interface PluginsBlock { enable: string[]; settings: Record<string, Values>; by_kind: Record<string, string[]>; auto_approve: Values }

export function pluginsBlock(values: Values | undefined): PluginsBlock {
  const raw = record(values?.plugins) ? values.plugins : {};
  const settings: Record<string, Values> = {};
  if (record(raw.settings)) for (const [id, v] of Object.entries(raw.settings)) settings[id] = record(v) ? v : {};
  const by_kind: Record<string, string[]> = {};
  if (record(raw.by_kind)) for (const [kind, v] of Object.entries(raw.by_kind)) by_kind[kind] = strings(v);
  return { enable: strings(raw.enable), settings, by_kind, auto_approve: record(raw.auto_approve) ? raw.auto_approve : {} };
}

/**
 * The edits that turn a tool on or off. Off also takes out its settings and the kinds' references to it (a kind left with no tool
 * goes), since the project file does not load while they name a tool that is not enabled; the old file is kept as a backup.
 */
export function toggleEdits(block: PluginsBlock, id: string, on: boolean): ConfigEdit[] {
  if (on) return block.enable.includes(id) ? [] : [{ path: ['plugins', 'enable'], value: [...block.enable, id] }];
  if (!block.enable.includes(id)) return [];
  const edits: ConfigEdit[] = [{ path: ['plugins', 'enable'], value: block.enable.filter(x => x !== id) }];
  if (Object.hasOwn(block.settings, id)) edits.push({ path: ['plugins', 'settings', id] });
  for (const [kind, ids] of Object.entries(block.by_kind)) {
    if (!ids.includes(id)) continue;
    const rest = ids.filter(x => x !== id);
    edits.push(rest.length ? { path: ['plugins', 'by_kind', kind], value: rest } : { path: ['plugins', 'by_kind', kind] });
  }
  return edits;
}

/** What turning a tool off also removes, for the question asked first (empty: nothing besides the tool itself). */
export function toggleLoses(block: PluginsBlock, id: string): { settings: boolean; kinds: string[] } {
  return { settings: Object.hasOwn(block.settings, id) && Object.keys(block.settings[id]!).length > 0, kinds: Object.entries(block.by_kind).filter(([, ids]) => ids.includes(id)).map(([kind]) => kind) };
}

/** A tool's settings being edited: a text per setting, or `undefined` for "not written: the default". */
export type SettingsDraft = Record<string, string | undefined>;

export function settingsDraft(written: Values | undefined, names: string[]): SettingsDraft {
  return Object.fromEntries(names.map(n => [n, written && Object.hasOwn(written, n) && written[n] !== undefined && written[n] !== null ? String(written[n]) : undefined]));
}

/**
 * The edit for one tool's settings: the whole `plugins.settings.<id>` mapping written when a value changed (a value that did not
 * change keeps how it was written, a number stays a number), removed when nothing is left. An empty text is a value of its own
 * (for example no key variable), not the default.
 */
export function settingsEdits(id: string, written: Values | undefined, draft: SettingsDraft): ConfigEdit[] {
  const before = written ?? {};
  const after: Values = {};
  for (const [name, value] of Object.entries(before)) if (!Object.hasOwn(draft, name)) after[name] = value;   // a setting the manifest no longer has stays as written
  for (const [name, value] of Object.entries(draft)) {
    if (value === undefined) continue;
    after[name] = Object.hasOwn(before, name) && String(before[name]) === value ? before[name] : value;
  }
  if (same(sortedKeys(before), sortedKeys(after))) return [];
  return Object.keys(after).length ? [{ path: ['plugins', 'settings', id], value: after }] : written === undefined ? [] : [{ path: ['plugins', 'settings', id] }];
}
const sortedKeys = (v: Values) => Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));

/** One line of `plugins.auto_approve` being edited: per_job is needed; the others may be empty (the defaults of the loader). */
export interface AutoRow { unit: string; per_job: string; per_day: string; per_project: string }

export function autoRows(written: Values): AutoRow[] {
  return Object.entries(written).map(([unit, v]) => record(v)
    ? { unit, per_job: text(v.per_job), per_day: text(v.per_day), per_project: text(v.per_project) }
    : { unit, per_job: text(v), per_day: '', per_project: '' });
}
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/**
 * The edit for `plugins.auto_approve`, and what is wrong first. A line with only per_job is written as the short form
 * (`{ images: 2 }`: two a job, ten jobs' worth a day); with per_day or per_project as the mapping.
 */
export function autoEdits(written: Values, rows: AutoRow[]): { edits: ConfigEdit[]; problems: { key: string; unit?: string; n?: number }[] } {
  const problems: { key: string; unit?: string; n?: number }[] = [];
  const after: Values = {};
  for (const row of rows) {
    const unit = row.unit.trim();
    if (!unit && !row.per_job.trim() && !row.per_day.trim() && !row.per_project.trim()) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(unit)) { problems.push({ key: 'unit' }); continue; }
    if (Object.hasOwn(after, unit)) { problems.push({ key: 'twice', unit }); continue; }
    const job = numberField(row.per_job), day = numberField(row.per_day), ever = numberField(row.per_project);
    if (!job.ok || job.value === undefined || job.value < 0) { problems.push({ key: 'per_job', unit }); continue; }
    if (!day.ok || (day.value !== undefined && day.value < 0) || !ever.ok || (ever.value !== undefined && ever.value < 0)) { problems.push({ key: 'limits', unit }); continue; }
    after[unit] = day.value === undefined && ever.value === undefined ? job.value
      : { per_job: job.value, ...(day.value !== undefined ? { per_day: day.value } : {}), ...(ever.value !== undefined ? { per_project: ever.value } : {}) };
  }
  const unchanged = Object.keys(after).length === Object.keys(written).length && Object.entries(after).every(([k, v]) => Object.hasOwn(written, k) && same(norm(written[k]), norm(v)));
  return { edits: problems.length || unchanged ? [] : sectionEdit(['plugins', 'auto_approve'], Object.keys(written).length ? written : undefined, after), problems };
}
const norm = (v: unknown) => (record(v) ? sortedKeys(v) : v);

/** One line of `plugins.by_kind`: a kind and the tools every order of it uses. */
export interface KindRow { kind: string; tools: string[] }

export function kindRows(byKind: Record<string, string[]>): KindRow[] {
  return Object.entries(byKind).map(([kind, tools]) => ({ kind, tools }));
}

/** The edit for `plugins.by_kind`, and what is wrong first: a kind named twice or without a name, a tool that is not on. */
export function kindEdits(written: Record<string, string[]>, rows: KindRow[], enabled: string[]): { edits: ConfigEdit[]; problems: { key: string; name?: string }[] } {
  const problems: { key: string; name?: string }[] = [];
  const after: Record<string, string[]> = {};
  for (const row of rows) {
    const kind = row.kind.trim();
    if (!kind && !row.tools.length) continue;
    if (!kind) { problems.push({ key: 'kind' }); continue; }
    if (Object.hasOwn(after, kind)) { problems.push({ key: 'twice', name: kind }); continue; }
    const off = row.tools.filter(id => !enabled.includes(id));
    if (off.length) { problems.push({ key: 'off', name: off.join(', ') }); continue; }
    if (row.tools.length) after[kind] = row.tools;
  }
  const before = Object.keys(written).length ? written : undefined;
  return { edits: problems.length ? [] : sectionEdit(['plugins', 'by_kind'], before, after), problems };
}

/** The file name of a path (either slash). */
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
