import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateProject } from '../config.ts';
import { fail, UserError } from '../i18n.ts';
import { backupFile } from '../yamledit.ts';

/**
 * The `producer:` section of a project file, edited as text: the lines under `producer:` are replaced, everything
 * else in the file stays byte for byte (comments, layout, line endings). The new file must pass the same validation
 * as `alba serve` uses, or nothing is written. Serve reads the project file again by itself.
 */
export interface ProducerConfigView { file: string; found: boolean; yaml: string }
export interface DiffLine { op: ' ' | '-' | '+'; text: string }
export interface ProducerConfigEdit { file: string; changed: boolean; dryRun: boolean; diff: DiffLine[]; backup?: string; before: string; after: string }

interface Section { lines: string[]; eol: string; bom: string; start: number; end: number; indent: string }

function section(text: string): Section {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length), eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(l => /^producer:\s*(#.*)?$/.test(l));
  if (start < 0) return { lines, eol, bom, start: -1, end: -1, indent: '  ' };
  let end = start + 1;
  // The section runs while lines are indented, blank or comments; a comment at column 0 followed by more
  // indented lines belongs to it, one followed by the next top-level key does not.
  while (end < lines.length) {
    const l = lines[end];
    if (/^\s+\S/.test(l) || l.trim() === '') { end++; continue; }
    if (/^#/.test(l)) { const next = lines.slice(end + 1).find(x => x.trim() !== '' && !/^#/.test(x)); if (next !== undefined && /^\s/.test(next)) { end++; continue; } }
    break;
  }
  while (end > start + 1 && (lines[end - 1].trim() === '' || /^#/.test(lines[end - 1]))) end--;
  const first = lines.slice(start + 1, end).find(l => /^\s+\S/.test(l));
  return { lines, eol, bom, start, end, indent: first?.match(/^\s+/)?.[0] ?? '  ' };
}
const dedent = (lines: string[], indent: string) => lines.map(l => l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()).join('\n');

export function readProducerConfig(file: string): ProducerConfigView {
  if (!existsSync(file)) fail('Project file not found: {file}', { file });
  const s = section(readFileSync(file, 'utf8'));
  return { file, found: s.start >= 0, yaml: s.start < 0 ? '' : dedent(s.lines.slice(s.start + 1, s.end), s.indent) + '\n' };
}

/** Longest-common-subsequence line diff; the sections are short (tens of lines). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n'), b = after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length, lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

export function editProducerConfig(file: string, yaml: string, options: { dryRun?: boolean; now?: Date } = {}): ProducerConfigEdit {
  if (!existsSync(file)) fail('Project file not found: {file}', { file });
  if (yaml.length > 100_000) fail('The producer section is longer than 100000 characters.');
  const original = readFileSync(file, 'utf8');
  const s = section(original);
  const before = s.start < 0 ? '' : dedent(s.lines.slice(s.start + 1, s.end), s.indent) + '\n';
  const wanted = yaml.replace(/\r\n/g, '\n').replace(/\t/g, '  ').replace(/\s+$/, '');
  let value: unknown;
  try { value = parse(wanted); } catch (e) { fail('The producer section is not valid YAML: {error}', { error: (e as Error).message.split('\n')[0] }); }
  if (value !== null && value !== undefined && (typeof value !== 'object' || Array.isArray(value))) fail('The producer section must be a mapping (key: value lines).');
  const block = wanted ? wanted.split('\n').map(l => l.trim() === '' ? '' : s.indent + l) : [];
  const lines = s.start < 0
    ? [...s.lines.slice(0, s.lines.at(-1) === '' ? -1 : undefined), 'producer:', ...block, ...(s.lines.at(-1) === '' ? [''] : [])]
    : [...s.lines.slice(0, s.start + 1), ...block, ...s.lines.slice(s.end)];
  const text = s.bom + lines.join(s.eol);
  const after = wanted ? wanted + '\n' : '';
  const diff = lineDiff(before, after);
  const changed = text !== original;
  // The whole file is checked as serve reads it; a problem anywhere stops the write.
  let raw: unknown;
  try { raw = parse(text.slice(s.bom.length)); } catch (e) { fail('The project file would not be valid YAML: {error}', { error: (e as Error).message.split('\n')[0] }); }
  try { validateProject(raw, file); } catch (e) { if (e instanceof UserError) throw e; throw new UserError((e as Error).message); }
  if (!changed || options.dryRun) return { file, changed, dryRun: !!options.dryRun, diff, before, after };
  const backup = backupFile(file, options.now ?? new Date());
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { file, changed, dryRun: false, diff, backup, before, after };
}
