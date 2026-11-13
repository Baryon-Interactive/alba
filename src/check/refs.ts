import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { fail } from '../i18n.ts';

/** One reference value: what a result should read, where that came from, and when it was set. */
export interface RefValue { value: string; source: string; updated: string }
export type Refs = Record<string, RefValue>;

/** What a result file says: the values found under each name, in order, and the names that were seen without any value. */
export interface ParsedResults { values: Map<string, string[]>; nameOnly: Set<string> }

/**
 * Reads a result file with the project's parser: a regular expression with the named groups `name` and `value`,
 * applied to every match in every line (so one alternation can pick up the name at the start of a line and each
 * value after it). A match with a name sets the line's current name; a match with a value belongs to the current name.
 * A line that has a name and no value is reported as "name only" (the run printed its name and then failed).
 */
export function parseResults(parser: string, text: string): ParsedResults {
  const re = new RegExp(parser, 'gu');
  const out: ParsedResults = { values: new Map(), nameOnly: new Set() };
  for (const line of text.split(/\r?\n/)) {
    let current: string | undefined;
    const found: string[] = [];
    for (const m of line.matchAll(re)) {
      if (m.groups?.name) { current = m.groups.name; found.length = 0; }
      if (m.groups?.value && current) found.push(m.groups.value);
    }
    if (!current) continue;
    if (found.length) out.values.set(current, [...(out.values.get(current) ?? []), ...found]);
    else out.nameOnly.add(current);
  }
  for (const name of out.values.keys()) out.nameOnly.delete(name);
  return out;
}

/** `name` for one value, `name#1`, `name#2` ... for several, in order of appearance. */
export function flatten(parsed: ParsedResults): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, list] of parsed.values) {
    if (list.length === 1) out.set(name, list[0]);
    else list.forEach((v, i) => out.set(`${name}#${i + 1}`, v));
  }
  return out;
}

/** The family a flat key belongs to: `ar1b#2` belongs to `ar1b`. */
export const familyOf = (key: string): string => key.replace(/#\d+$/, '');

export function loadRefs(file: string): Refs {
  if (!existsSync(file)) return {};
  const raw = parse(readFileSync(file, 'utf8')) as unknown;
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('{file}: the reference values must be a mapping of name to value, source, updated.', { file });
  const refs: Refs = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<RefValue> | null;
    if (typeof r !== 'object' || r === null || r.value === undefined) fail('{file}: "{name}" needs a "value".', { file, name });
    refs[name] = { value: String(r.value), source: String(r.source ?? ''), updated: String(r.updated ?? '') };
  }
  return refs;
}

export function saveRefs(file: string, refs: Refs): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  writeFileSync(file, `# Reference values: name -> value, where it came from, when it was set. Changed with "alba refs adopt".\n${stringify(sorted)}`, 'utf8');
}

export type RefStatus = 'same' | 'different' | 'missing' | 'new';
export interface RefRow { name: string; status: RefStatus; reference?: string; got?: string; from?: string; why?: string }

/** Several result files, in the order given: a later file replaces the values an earlier one had for the same name. */
export function mergeResults(files: { file: string; parsed: ParsedResults }[]): { flat: Map<string, { value: string; from: string }>; nameOnly: Map<string, string> } {
  const byName = new Map<string, { list: string[]; from: string }>();
  const nameOnly = new Map<string, string>();
  for (const { file, parsed } of files) {
    for (const [name, list] of parsed.values) byName.set(name, { list, from: path.basename(file) });
    for (const name of parsed.nameOnly) if (!byName.has(name)) nameOnly.set(name, path.basename(file));
  }
  for (const name of byName.keys()) nameOnly.delete(name);
  const flat = new Map<string, { value: string; from: string }>();
  for (const [name, { list, from }] of byName) {
    if (list.length === 1) flat.set(name, { value: list[0], from });
    else list.forEach((v, i) => flat.set(`${name}#${i + 1}`, { value: v, from }));
  }
  return { flat, nameOnly };
}

/** Compares merged results with the reference values: same, different, missing (not in the results, or only a name) and new. */
export function compare(refs: Refs, merged: ReturnType<typeof mergeResults>): RefRow[] {
  const rows: RefRow[] = [];
  for (const [name, ref] of Object.entries(refs)) {
    const got = merged.flat.get(name);
    if (got) rows.push({ name, status: got.value === ref.value ? 'same' : 'different', reference: ref.value, got: got.value, from: got.from });
    else {
      const only = merged.nameOnly.get(familyOf(name));
      rows.push({ name, status: 'missing', reference: ref.value, from: only, why: only ? 'the result names it but gives no value' : 'not in the results' });
    }
  }
  for (const [name, got] of merged.flat) if (!(name in refs)) rows.push({ name, status: 'new', got: got.value, from: got.from });
  const order: Record<RefStatus, number> = { different: 0, missing: 1, new: 2, same: 3 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** Takes the named values (a name also takes its `#n` family) from a result file into the reference values. */
export function adopt(refs: Refs, parsed: ParsedResults, names: string[] | 'all', source: string, updated: string): { refs: Refs; adopted: string[]; notFound: string[] } {
  const flat = flatten(parsed);
  const next: Refs = { ...refs };
  const wanted = names === 'all' ? [...flat.keys()] : [...flat.keys()].filter(k => names.includes(k) || names.includes(familyOf(k)));
  for (const key of wanted) next[key] = { value: flat.get(key)!, source, updated };
  // a name that now has several values must not keep an old single one, and the other way round
  const families = new Set(wanted.map(familyOf));
  for (const key of Object.keys(next)) if (families.has(familyOf(key)) && !flat.has(key)) delete next[key];
  const notFound = names === 'all' ? [] : names.filter(n => ![...flat.keys()].some(k => k === n || familyOf(k) === n));
  return { refs: next, adopted: wanted, notFound };
}
