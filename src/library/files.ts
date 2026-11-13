import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { appendStateFile, readStateFile } from '../orders/state-files.ts';
import type { ProjectConfig } from '../config.ts';

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** A relative path with forward slashes that stays inside its folder: no `..`, no drive, no escapes. */
export function cleanRel(rel: unknown): rel is string {
  return typeof rel === 'string' && rel.trim() !== '' && !/[\\:\0%]/.test(rel) && !rel.startsWith('/') && !rel.split('/').some(s => s === '..' || s === '.' || s === '');
}

/** The full path of an existing file under `root`, or undefined when the path is not clean, missing, not a file, or reaches out through a link. */
export function safeFile(root: string, rel: string): string | undefined {
  if (!cleanRel(rel)) return undefined;
  const target = path.resolve(root, rel);
  if (!inside(path.resolve(root), target) || !existsSync(root) || !existsSync(target)) return undefined;
  try {
    if (!inside(realpathSync(root), realpathSync(target)) || !statSync(target).isFile()) return undefined;
  } catch { return undefined; }
  return target;
}

/** Files below `dir` (relative paths, forward slashes, sorted); links are not followed. */
export function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export const relTo = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

/** Lines of a JSON-lines file: the objects, and a note for each line that is not one. A file that is not there is empty, not an error. */
export function readJsonl(file: string | undefined): { items: { line: number; value: Record<string, unknown> }[]; problems: string[] } {
  const out = { items: [] as { line: number; value: Record<string, unknown> }[], problems: [] as string[] };
  if (!file || !existsSync(file)) return out;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) { out.problems.push(`${path.basename(file)}: ${(e as Error).message}`); return out; }
  return parseJsonl(text, path.basename(file));
}

function parseJsonl(text: string, file: string): ReturnType<typeof readJsonl> {
  const out = { items: [] as { line: number; value: Record<string, unknown> }[], problems: [] as string[] };
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
      out.items.push({ line: i + 1, value: v as Record<string, unknown> });
    } catch { out.problems.push(`${path.basename(file)}: line ${i + 1} is not a JSON object`); }
  });
  return out;
}

/** One append, after a newline if the file ends in a partial line. */
export function appendJsonl(file: string, record: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}${JSON.stringify(record)}\n`, 'utf8');
}

export const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where alba keeps its own records of the library (the state folder; files starting with `_` are never read as orders). */
export const libraryFile = (stateDir: string, name: 'picks' | 'settings' | 'approvals'): string => path.join(stateDir, `_${name}.jsonl`);

/** Read the same JSONL layout from either backend, keeping line numbers and malformed-line diagnostics. */
export function readStateJsonl(project: ProjectConfig, name: string): ReturnType<typeof readJsonl> {
  const file = `_${name}.jsonl`;
  const text = readStateFile(project, file);
  return parseJsonl(text ?? '', file);
}
export function appendStateJsonl(project: ProjectConfig, name: string, record: Record<string, unknown>): void {
  appendStateFile(project, `_${name}.jsonl`, JSON.stringify(record) + '\n');
}
