import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, isMap, isSeq, parse, parseDocument, type YAMLMap } from 'yaml';
import { UserError, fail } from './i18n.ts';

/** A refused edit: what is wrong, by field when it can be said. The API answers it as 400 with `details`. */
export class EditRefused extends UserError {
  readonly details: { field?: string; message: string }[];
  constructor(message: string, details: { field?: string; message: string }[] = [{ message }]) { super(message); this.details = details; }
}

/** How many backups of a configuration file are kept. */
export const BACKUPS_KEPT = 20;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Makes the value at `at` in the YAML document equal to `value`, touching as little as possible so that comments and the
 * layout of what did not change stay: a mapping is compared key by key (a key that is not in the new value is removed),
 * anything else is replaced as a whole when it differs. `undefined` removes the key. Returns the dotted names that changed.
 */
export function assign(doc: Document, at: (string | number)[], value: unknown, old: unknown): string[] {
  const name = at.join('.');
  if (value === undefined) { if (old === undefined) return []; doc.deleteIn(at); return [name]; }
  if (isPlain(value) && isPlain(old) && isMap(doc.getIn(at, true))) {
    const changed: string[] = [];
    for (const key of Object.keys(old)) if (!(key in value)) { doc.deleteIn([...at, key]); changed.push([...at, key].join('.')); }
    for (const [key, v] of Object.entries(value)) changed.push(...assign(doc, [...at, key], v, old[key]));
    return changed;
  }
  if (same(value, old)) return [];
  doc.setIn(at, doc.createNode(value));
  return [name];
}

/** A line without the spacing the YAML writer is free to change: runs of blanks (before comments, between items) and the blanks inside flow brackets. */
const squash = (line: string): string => line.replace(/^(\s*)(.*)$/, (_, indent: string, rest: string) => indent + rest.replace(/\s+/g, ' ').replace(/([[{]) /g, '$1').replace(/ ([\]}])/g, '$1').trimEnd());

/**
 * The YAML writer re-spaces some lines it did not change (it puts one blank before a comment, a blank inside `[ ]`). So that a
 * diff of the file shows only what was edited, a line of the new text that matches a line of the old one except for that
 * spacing is given back as it was written. Used only when the result still reads as the same data.
 */
export function restoreLayout(original: string, written: string): string {
  const a = original.split('\n'), b = written.split('\n');
  const na = a.map(squash), nb = b.map(squash);
  let lo = 0;
  while (lo < a.length && lo < b.length && na[lo] === nb[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && na[ea - 1] === nb[eb - 1]) { ea--; eb--; }
  const out = b.slice();
  for (let i = 0; i < lo; i++) out[i] = a[i];
  for (let k = 0; k < a.length - ea; k++) out[b.length - 1 - k] = a[a.length - 1 - k];
  // the middle: lines that stayed between the changes (a longest common subsequence of the squashed lines)
  const n = ea - lo, m = eb - lo;
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    const w = m + 1, dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = na[lo + i] === nb[lo + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (na[lo + i] === nb[lo + j]) { out[lo + j] = a[lo + i]; i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  const restored = out.join('\n');
  try { if (JSON.stringify(parse(restored)) === JSON.stringify(parse(written))) return restored; } catch { /* fall through */ }
  return written;
}

export interface EditOutcome { changed: string[]; backup?: string; dryRun: boolean }

/** `YYYYMMDD-HHMMSS` in local time. */
function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Copies the file to `<file>.bak-<time>` and removes all but the newest `keep` backups of it. */
export function backupFile(file: string, now: Date, keep = BACKUPS_KEPT): string {
  const dir = path.dirname(file), base = path.basename(file);
  let backup = path.join(dir, `${base}.bak-${stamp(now)}`);
  for (let n = 2; existsSync(backup); n++) backup = path.join(dir, `${base}.bak-${stamp(now)}-${n}`);
  copyFileSync(file, backup);
  const mine = readdirSync(dir).filter(f => f.startsWith(`${base}.bak-`) && /^\d{8}-\d{6}(-\d+)?$/.test(f.slice(base.length + 5))).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) { try { unlinkSync(path.join(dir, old)); } catch { /* a backup that cannot be removed stays */ } }
  return backup;
}

/**
 * Edits a YAML file in place with its comments and order kept.
 *  1. `mutate` changes the parsed document and returns what it changed (nothing changed: nothing is written);
 *  2. `validate` is given the new text and throws (an `EditRefused`, or any `UserError`) when the result is not acceptable;
 *  3. unless `dryRun`, the old file is copied to a backup and the new text is written (through a temporary file).
 * The line endings and a leading byte-order mark of the file are kept.
 */
export function editYaml(file: string, mutate: (doc: Document) => string[], validate: (text: string) => void, options: { dryRun?: boolean; now?: Date } = {}): EditOutcome {
  if (!existsSync(file)) fail('File not found: {file}', { file });
  const original = readFileSync(file, 'utf8');
  const bom = original.startsWith('﻿') ? '﻿' : '';
  const crlf = /\r\n/.test(original);
  const doc = parseDocument(original.slice(bom.length));
  if (doc.errors.length) fail('{file} is not valid YAML: {error}', { file, error: doc.errors[0].message.split('\n')[0] });
  const changed = mutate(doc);
  if (!changed.length) return { changed, dryRun: !!options.dryRun };
  let text = restoreLayout(original.slice(bom.length).replace(/\r\n/g, '\n'), doc.toString({ lineWidth: 0 }));
  if (crlf) text = text.replace(/\r?\n/g, '\r\n');
  validate(text);
  if (options.dryRun) return { changed, dryRun: true };
  const backup = backupFile(file, options.now ?? new Date());
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, bom + text, 'utf8');
  renameSync(tmp, file);
  return { changed, backup, dryRun: false };
}

/** The mapping at `at` as a plain object, or undefined. */
export function plainAt(doc: Document, at: (string | number)[]): unknown {
  const node = doc.getIn(at, true);
  return node === undefined ? undefined : (node as { toJSON?: () => unknown }).toJSON?.() ?? node;
}

/** The item of the sequence at `listAt` whose key `idKey` is `id`, with its index. */
export function findItem(doc: Document, listAt: (string | number)[], idKey: string, id: string): { index: number; map: YAMLMap } | undefined {
  const list = doc.getIn(listAt, true);
  if (!isSeq(list)) return undefined;
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    if (isMap(item) && String(item.get(idKey)) === id) return { index: i, map: item };
  }
  return undefined;
}
