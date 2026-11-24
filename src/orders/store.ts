import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OrderDoc, OrderEvent } from './model.ts';
import { fail, t } from '../i18n.ts';
import { tryLock } from '../fs/lock.ts';

/** Everything the engine needs from storage. A `node:sqlite` implementation can replace the file one. */
export interface OrderStore {
  readonly dir?: string;
  tags(): string[];
  all?(): OrderDoc[];
  read(tag: string): OrderDoc | undefined;
  write(doc: OrderDoc): void;
  appendEvent(event: OrderEvent): void;
  events(options?: { tag?: string; limit?: number }): OrderEvent[];
  transaction<T>(change: () => T): T;
  readMeta(name: string): unknown;
  writeMeta(name: string, value: unknown): void;
}

/** The document has changed since it was read. */
export class StaleWrite extends Error {
  readonly tag: string;
  constructor(tag: string) { super(t('Stale write for order {tag}; read it again.', { tag })); this.tag = tag; this.name = 'StaleWrite'; }
}

/** Storage revision stays outside OrderDoc's public JSON shape (version: 1 is the document format). */
const revisions = new WeakMap<OrderDoc, number>();
export const revisionOf = (doc: OrderDoc): number => revisions.get(doc) ?? 0;
export const withRevision = (doc: OrderDoc, revision: number): OrderDoc => { revisions.set(doc, revision); return doc; };
export function validateTag(tag: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[1-8])?$/.test(tag)) fail('Invalid order tag "{tag}": use letters, digits, "-" and "_", starting with a letter.', { tag });
}

/** Writes via a temporary file in the same directory, then renames, so readers never see half a file. */
export function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, file); break; } catch (e) {
        // Windows can briefly refuse to replace a file another process has open.
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        const until = Date.now() + 20 * (attempt + 1);
        while (Date.now() < until) { /* spin: renames are rare and short */ }
      }
    }
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** Does the file end without a line end (its last write was cut short)? Reads the last byte only. */
function endsMidLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  if (!size) return false;
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); return b[0] !== 0x0a; } finally { closeSync(fd); }
}

export class FileStore implements OrderStore {
  readonly dir: string;
  private locked = false;
  constructor(dir: string) { this.dir = dir; }

  private fileOf(tag: string): string {
    validateTag(tag);
    return path.join(this.dir, `${tag}.json`);
  }

  tags(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'serve.exit.json').map(f => f.slice(0, -5)).sort();
  }

  read(tag: string): OrderDoc | undefined {
    const file = this.fileOf(tag);
    if (!existsSync(file)) return undefined;
    const stored = JSON.parse(readFileSync(file, 'utf8')) as OrderDoc & { _storeVersion?: number };
    const { _storeVersion = 1, ...doc } = stored;
    if (doc.version !== 1) fail('State file {file} has unsupported version {version}.', { file, version: String(doc.version) });
    return withRevision(doc, _storeVersion);
  }

  write(doc: OrderDoc): void {
    this.atomically(() => {
      const file = this.fileOf(doc.order.tag);
      const current = this.read(doc.order.tag);
      const version = revisionOf(doc);
      if (current ? revisionOf(current) !== version : version !== 0) throw new StaleWrite(doc.order.tag);
      this.remember(file);
      writeFileAtomic(file, JSON.stringify({ ...doc, _storeVersion: version + 1 }, null, 2) + '\n');
      withRevision(doc, version + 1);
    });
  }

  /**
   * Serializes changes across processes, and rolls a transaction back as SQLite does: every file it changes is remembered (its
   * content before, or that it did not exist; the length of the event log) in `_write.journal` before the first change. A change
   * that throws restores them; a process that died inside a transaction leaves the journal, and the next writer restores it
   * first. The short-lived lock and the journal are never state to migrate.
   */
  transaction<T>(change: () => T): T { return this.run(change, true); }

  /** One write of its own (a document or an event): atomic by itself, so it needs no journal unless a transaction is open. */
  private atomically<T>(change: () => T): T { return this.run(change, false); }

  private journal?: { durable: boolean; files: Map<string, string | null>; events?: number };

  private run<T>(change: () => T, durable: boolean): T {
    if (this.locked) return change();
    mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, '_write.lock');
    const deadline = Date.now() + 5000;
    let release: (() => void) | undefined;
    while (!(release = tryLock(lock))) {
      if (Date.now() >= deadline) fail('State is busy; try again shortly.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    this.locked = true;
    try {
      this.recover();
      this.journal = { durable, files: new Map() };
      try {
        const result = change();
        rmSync(this.journalFile, { force: true });
        return result;
      } catch (error) {
        this.rollback(this.journal.files, this.journal.events);
        rmSync(this.journalFile, { force: true });
        throw error;
      }
    } finally { this.journal = undefined; this.locked = false; release(); }
  }

  private get journalFile(): string { return path.join(this.dir, '_write.journal'); }

  /** Notes a file's content before its first change in this transaction (and writes the journal down first, when durable). */
  private remember(file: string, events = false): void {
    const journal = this.journal;
    if (!journal) return;
    if (events) { if (journal.events !== undefined) return; journal.events = existsSync(file) ? statSync(file).size : 0; }
    else { if (journal.files.has(file)) return; journal.files.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null); }
    if (journal.durable) writeFileAtomic(this.journalFile, JSON.stringify({ pid: process.pid, files: Object.fromEntries([...journal.files].map(([f, text]) => [path.basename(f), text])), ...(journal.events !== undefined ? { events: journal.events } : {}) }) + '\n');
  }

  /** A journal left by a process that died inside a transaction: put back what it had changed. */
  private recover(): void {
    if (!existsSync(this.journalFile)) return;
    let saved: { files?: Record<string, string | null>; events?: number };
    try { saved = JSON.parse(readFileSync(this.journalFile, 'utf8')); }
    catch { rmSync(this.journalFile, { force: true }); return; } // cut short before any change was made
    const files = new Map(Object.entries(saved.files ?? {}).filter(([name]) => !name.includes('/') && !name.includes('\\') && name !== '..').map(([name, text]) => [path.join(this.dir, name), text]));
    this.rollback(files, saved.events);
    rmSync(this.journalFile, { force: true });
  }

  private rollback(files: Map<string, string | null>, events: number | undefined): void {
    for (const [file, text] of files) {
      if (text === null) rmSync(file, { force: true });
      else writeFileAtomic(file, text);
    }
    const log = path.join(this.dir, 'events.jsonl');
    if (events !== undefined && existsSync(log) && statSync(log).size > events) truncateSync(log, events);
  }

  appendEvent(event: OrderEvent): void {
    this.atomically(() => {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, 'events.jsonl');
      this.remember(file, true);
      // A crash in the middle of a write leaves a line without its end; start on a line of our own.
      appendFileSync(file, (endsMidLine(file) ? '\n' : '') + JSON.stringify(event) + '\n', 'utf8');
    });
  }

  events(options: { tag?: string; limit?: number } = {}): OrderEvent[] {
    const file = path.join(this.dir, 'events.jsonl');
    if (!existsSync(file)) return [];
    // A line that does not parse (a write cut short) is skipped, not fatal: every reader of events would fail on it.
    const all = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as OrderEvent]; } catch { return []; } })
      .filter(e => !options.tag || e.tag === options.tag);
    return options.limit ? all.slice(-options.limit) : all;
  }

  readMeta(name: string): unknown {
    const file = path.join(this.dir, `_${name}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  }

  writeMeta(name: string, value: unknown): void {
    this.atomically(() => {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `_${name}.json`);
      this.remember(file);
      writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
    });
  }
}
