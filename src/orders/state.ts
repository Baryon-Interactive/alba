import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { acquireLock, lockHolder } from '../serve/lock.ts';
import { SqliteStore } from './sqlite-store.ts';
import { FileStore, withRevision, writeFileAtomic } from './store.ts';
import { fileKey } from './state-files.ts';
import { fail } from '../i18n.ts';
import type { QuotaReading } from '../workers/quota.ts';

export interface StateCounts { orders: number; events: number; meta: number; 'quota-history': number }

/** Only alba-owned side state is moved. Source documents, logs, locks and image bytes stay files. */
export function sideFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && (/^_.+\.jsonl?$/.test(e.name) || (e.name.endsWith('.jsonl') && !['events.jsonl', 'quota-history.jsonl'].includes(e.name)))) result.push(e.name);
  }
  for (const rel of ['refs/index.json', 'refs/failures.json']) if (existsSync(path.join(dir, rel))) result.push(rel);
  const backups = path.join(dir, 'backups');
  if (existsSync(backups)) for (const e of readdirSync(backups, { withFileTypes: true })) if (e.isFile()) result.push(`backups/${e.name}`);
  return result.sort();
}

export function migrateState(stateDir: string, options: { dryRun?: boolean } = {}): { from: StateCounts; to: StateCounts; backup?: string } {
  const holder = lockHolder(stateDir);
  if (holder) fail('Cannot migrate state while alba serve holds {dir} (pid {pid}). Stop it first.', { dir: stateDir, pid: holder.pid });
  if (existsSync(path.join(stateDir, 'state.sqlite'))) fail('State database already exists; export or check it instead of migrating again.');
  const source = new FileStore(stateDir);
  const inspect = () => {
    const docs = source.tags().map(tag => source.read(tag)!);
    const events = source.events();
    const files = sideFiles(stateDir);
    const entries = files.map(rel => [rel, readFileSync(path.join(stateDir, rel), 'utf8')] as const);
    const quotaFile = path.join(stateDir, 'quota-history.jsonl');
    const quota: QuotaReading[] = existsSync(quotaFile) ? readFileSync(quotaFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as QuotaReading) : [];
    const from = { orders: docs.length, events: events.length, meta: entries.length, 'quota-history': quota.length };
    return { docs, events, files, entries, quota, from };
  };
  if (options.dryRun) { const { from } = inspect(); return { from, to: { ...from } }; }
  const release = acquireLock(stateDir, { pid: process.pid, started: new Date().toISOString() });
  try { return source.transaction(() => {
    const { docs, events, files, entries, quota, from } = inspect();
    const staging = path.join(stateDir, `_migrate-${randomUUID()}`);
    const backup = path.join(stateDir, `_files-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const moved: string[] = [];
    let installed = false;
    const sqlite = new SqliteStore(staging);
    let to: StateCounts;
    try {
      sqlite.transaction(() => {
        for (const doc of docs) sqlite.write(withRevision(doc, 0));
        for (const event of events) sqlite.appendEvent(event);
        for (const reading of quota) sqlite.appendQuotaReading(reading);
        for (const [rel, text] of entries) {
          if (/^_[^/]+\.json$/.test(rel)) sqlite.writeMeta(rel.slice(1, -5), JSON.parse(text));
          else sqlite.writeMeta(fileKey(rel), text);
        }
        to = sqlite.counts();
        for (const doc of docs) if (!isDeepStrictEqual(doc, sqlite.read(doc.order.tag))) fail('Migration check failed for order {tag}.', { tag: doc.order.tag });
        if (!isDeepStrictEqual(events, sqlite.events()) || !isDeepStrictEqual(quota, sqlite.allQuotaHistory()) || !isDeepStrictEqual(from, to)) fail('Migration counts or event contents differ; source files are untouched.');
        for (const [rel, text] of entries) {
          const value = /^_[^/]+\.json$/.test(rel) ? sqlite.readMeta(rel.slice(1, -5)) : sqlite.readMeta(fileKey(rel));
          if (!isDeepStrictEqual(value, /^_[^/]+\.json$/.test(rel) ? JSON.parse(text) : text)) fail('Migration check failed for side file {file}.', { file: rel });
        }
      });
    } finally { sqlite.close(); }
    try {
      renameSync(path.join(staging, 'state.sqlite'), path.join(stateDir, 'state.sqlite')); installed = true;
      mkdirSync(backup, { recursive: true });
      for (const rel of [...source.tags().map(tag => `${tag}.json`), ...['events.jsonl', 'quota-history.jsonl'].filter(rel => existsSync(path.join(stateDir, rel))), ...files]) {
        mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
        renameSync(path.join(stateDir, rel), path.join(backup, rel)); moved.push(rel);
      }
    } catch (error) {
      for (const rel of moved.reverse()) renameSync(path.join(backup, rel), path.join(stateDir, rel));
      if (installed) rmSync(path.join(stateDir, 'state.sqlite'), { force: true });
      throw error;
    } finally { rmSync(staging, { recursive: true, force: true }); }
    return { from, to: to!, backup };
  }); } finally { release(); }
}

export function exportState(stateDir: string, outDir: string): StateCounts {
  if (!existsSync(path.join(stateDir, 'state.sqlite'))) fail('No state database exists; migrate the file state first.');
  if (path.resolve(stateDir) === path.resolve(outDir)) fail('Export needs a separate empty directory.');
  if (existsSync(outDir) && readdirSync(outDir).length) fail('Export needs a separate empty directory.');
  const store = new SqliteStore(stateDir);
  try { return store.transaction(() => {
    mkdirSync(outDir, { recursive: true });
    for (const doc of store.all()) writeFileAtomic(path.join(outDir, `${doc.order.tag}.json`), JSON.stringify(doc, null, 2) + '\n');
    const events = store.events();
    if (events.length) writeFileAtomic(path.join(outDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const quota = store.allQuotaHistory();
    writeFileAtomic(path.join(outDir, 'quota-history.jsonl'), quota.map(q => JSON.stringify(q) + '\n').join(''));
    for (const row of store.db.prepare('SELECT name, value FROM meta ORDER BY name').all()) {
      const name = row.name as string;
      const value = name === 'usage' ? store.readMeta(name) : JSON.parse(row.value as string);
      const rel = name.startsWith('file:') ? name.slice(5) : `_${name}.json`;
      const dest = path.resolve(outDir, rel);
      if (path.relative(path.resolve(outDir), dest).startsWith('..') || path.isAbsolute(rel)) fail('Invalid metadata path {file}.', { file: rel });
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileAtomic(dest, name.startsWith('file:') ? value as string : JSON.stringify(value, null, 2) + '\n');
    }
    return store.counts();
  }); } finally { store.close(); }
}

export function checkState(stateDir: string): StateCounts & { ok: boolean; integrity: string } {
  if (!existsSync(path.join(stateDir, 'state.sqlite'))) fail('No state database exists; migrate the file state first.');
  const store = new SqliteStore(stateDir);
  try { return store.transaction(() => {
    const integrity = store.db.prepare('PRAGMA integrity_check').all().map(row => String(row.integrity_check)).join('\n');
    return { ok: integrity === 'ok', ...store.counts(), integrity };
  }); } finally { store.close(); }
}
