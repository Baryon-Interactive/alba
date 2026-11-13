import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '../check/general.ts';
import { DesignError, type Param } from './model.ts';

export function relativePath(value: string): boolean {
  return !!value && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-z]+:/i.test(value) && !value.split('/').some(s => s === '..' || s === '.' || !s);
}
export function projectFile(root: string, relative: string): string {
  if (!relativePath(relative)) throw new DesignError(`Expected a project-relative file: ${relative}`);
  const full = path.resolve(root, relative), real = realpathSync(full);
  const rel = path.relative(realpathSync(root), real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !statSync(real).isFile()) throw new DesignError(`File leaves the project or is not a file: ${relative}`);
  return full;
}
export function pointerValue(document: unknown, pointer: string): unknown {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')) || /~(?:[^01]|$)/.test(pointer)) throw new DesignError(`Invalid RFC 6901 pointer: ${pointer}`);
  let value = document;
  if (!pointer) return value;
  for (const encoded of pointer.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part) || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part))) throw new DesignError(`JSON pointer does not resolve: ${pointer}`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
/** Owned by one operation; aliases share a real-path entry, including parse failures. */
export class JsonDataCache {
  private entries = new Map<string, { value?: unknown; error?: Error }>();
  private paths = new Map<string, string | Error>();
  parses = 0;
  read(root: string, relative: string): unknown {
    const key = `${path.resolve(root)}\0${relative}`;
    let file = this.paths.get(key);
    if (!file) {
      try { file = realpathSync(projectFile(root, relative)); }
      catch (error) { file = error as Error; }
      this.paths.set(key, file);
    }
    if (file instanceof Error) throw file;
    let entry = this.entries.get(file);
    if (!entry) {
      entry = {};
      try { this.parses++; entry.value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { entry.error = error as Error; }
      this.entries.set(file, entry);
    }
    if (entry.error) throw entry.error;
    return entry.value;
  }
}
export function codeRefError(root: string, code: string): string | undefined {
  const match = /^(.+):(\d+)$/.exec(code);
  if (!match || Number(match[2]) < 1) return `code_refs need file:line: ${code}`;
  try {
    if (Number(match[2]) > readFileSync(projectFile(root, match[1]), 'utf8').split('\n').length) return `code line does not exist: ${code}`;
  } catch (error) { return (error as Error).message; }
}
export function resolveParam(root: string, param: Param, cache = new JsonDataCache()): unknown {
  if (!param.location.file.endsWith('.json')) throw new DesignError('Parameter location must be a JSON file.');
  return pointerValue(cache.read(root, param.location.file), param.location.pointer);
}
export function typeMatches(type: Param['type'], value: unknown): boolean {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return typeof value === 'number' && Number.isFinite(value) && (type === 'float' || Number.isSafeInteger(value));
}
export const outsideRange = (value: unknown, min: number | null, max: number | null): boolean => typeof value === 'number' && ((min !== null && value < min) || (max !== null && value > max));
export function dataFiles(root: string, patterns: string[]): string[] {
  const matches = patterns.map(globToRegExp), found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (['.git', 'node_modules', '.alba'].includes(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (lstatSync(path.join(root, rel)).isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && matches.some(re => re.test(rel))) { projectFile(root, rel); found.push(rel); }
    }
  };
  if (patterns.length) walk('');
  return found.sort();
}
export function numericLeaves(value: unknown, pointer = ''): string[] {
  if (typeof value === 'number') return [pointer];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => numericLeaves(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}
