import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { backendName, stateStore, type StateProject } from './backend.ts';
import { writeFileAtomic } from './store.ts';
import { SqliteStore } from './sqlite-store.ts';
import type { QuotaReading } from '../workers/quota.ts';

/** Directory-only internal helpers select the existing store; project callers pass an explicit backend. */
export function stateProject(target: StateProject | string): StateProject {
  return typeof target === 'string' ? { state_dir: target, state: { backend: existsSync(path.join(target, 'state.sqlite')) ? 'sqlite' : 'files' } } : target;
}
export const fileKey = (rel: string): string => /^_[^/\\]+\.json$/.test(rel) ? rel.slice(1, -5) : `file:${rel.replace(/\\/g, '/')}`;
export function readStateFile(target: StateProject | string, rel: string): string | undefined {
  const project = stateProject(target);
  if (backendName(project) === 'sqlite') {
    const store = stateStore(project) as SqliteStore;
    if (rel === 'quota-history.jsonl') return store.allQuotaHistory().map(q => JSON.stringify(q) + '\n').join('');
    const value = store.readMeta(fileKey(rel));
    return value === undefined ? undefined : fileKey(rel).startsWith('file:') ? value as string : JSON.stringify(value);
  }
  const file = path.join(project.state_dir, rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}
export function writeStateFile(target: StateProject | string, rel: string, text: string): void {
  const project = stateProject(target);
  if (backendName(project) === 'sqlite') {
    if (rel === 'quota-history.jsonl') {
      const store = stateStore(project) as SqliteStore;
      store.transaction(() => { store.db.exec('DELETE FROM quota_history'); appendStateFile(project, rel, text); });
    } else stateStore(project).writeMeta(fileKey(rel), fileKey(rel).startsWith('file:') ? text : JSON.parse(text));
    return;
  }
  const file = path.join(project.state_dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
}
export function stateTransaction<T>(target: StateProject | string, change: () => T): T {
  return stateStore(stateProject(target)).transaction(change);
}
export function appendStateFile(target: StateProject | string, rel: string, text: string): void {
  const project = stateProject(target);
  if (backendName(project) === 'sqlite') {
    if (rel === 'quota-history.jsonl') {
      const store = stateStore(project) as SqliteStore;
      store.transaction(() => { for (const line of text.split('\n').filter(Boolean)) store.appendQuotaReading(JSON.parse(line) as QuotaReading); });
    } else stateTransaction(project, () => writeStateFile(project, rel, (readStateFile(project, rel) ?? '') + text));
  } else {
    mkdirSync(path.dirname(path.join(project.state_dir, rel)), { recursive: true });
    appendFileSync(path.join(project.state_dir, rel), text, 'utf8');
  }
}
export function readStateJson<T>(target: StateProject | string, rel: string, fallback: T): T {
  const text = readStateFile(target, rel);
  return text === undefined ? fallback : JSON.parse(text) as T;
}
export function updateStateJson<T>(target: StateProject | string, rel: string, fallback: T, change: (value: T) => T): T {
  return stateTransaction(target, () => {
    const next = change(readStateJson(target, rel, fallback));
    writeStateFile(target, rel, JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}
