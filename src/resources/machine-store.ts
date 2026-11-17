import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';

export type MachineLeaseKind = 'dispatch' | 'acceptance' | 'tool' | 'nightly';
export type WaiterPriority = 'rework' | 'new';

export interface MachineLeaseRow {
  resource: string;
  project: string;
  state_dir: string;
  tag: string;
  run?: string;
  since: string;
  expires: string;
  pid?: number;
  started_at?: string;
  unverified?: boolean;
  every_minutes?: number;
  kind: MachineLeaseKind;
  heartbeat_at: string;
}

export interface MachineWaiterRow {
  resource: string;
  project: string;
  tag: string;
  priority: WaiterPriority;
  enqueued_at: string;
  heartbeat_at: string;
  position: number;
}

export interface MachineHoldRow {
  id: number;
  resource: string;
  project: string;
  tag: string;
  minutes: number;
  ended_at: string;
}

export interface MachineStoreContext {
  file?: string;
  everyMinutes?: number;
  print?: (line: string) => void;
}

const DECLARATION_LIVE_MS = 24 * 3600 * 1000;
const WAITER_STALE_MS = 10 * 60 * 1000;
const HOLD_KEEP_LIMIT = 50;
const HOLD_MEDIAN_SAMPLE = 20;
const HOLD_MIN_SAMPLE = 3;

/**
 * Per-OS-account directory for the machine store: `ALBA_MACHINE_DIR` when set, `%LOCALAPPDATA%\alba\machine` on Windows,
 * else `$XDG_STATE_HOME/alba/machine` or `~/.local/state/alba/machine`.
 */
export function machineDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALBA_MACHINE_DIR) return path.resolve(env.ALBA_MACHINE_DIR);
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'alba', 'machine');
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'alba', 'machine');
  return path.join(os.homedir(), '.local', 'state', 'alba', 'machine');
}

export const machineStorePath = (env: NodeJS.ProcessEnv = process.env): string => path.join(machineDir(env), 'machine.sqlite');

export const hasMachineResources = (project: ProjectConfig): boolean =>
  Object.values(project.resources ?? {}).some(r => r.scope === 'machine');

/** Estimated wait in minutes, rounded up to 5 minutes, or undefined when `median` is unknown. */
export function estimateWaitMinutes(median: number | undefined, position: number, slots: number, currentHoldMinutes: readonly number[]): number | undefined {
  if (median === undefined) return undefined;
  const s = Math.max(1, slots);
  const k = Math.max(1, position);
  const longest = currentHoldMinutes.length ? Math.max(...currentHoldMinutes) : 0;
  const raw = (currentHoldMinutes.length ? Math.max(0, median - longest) : 0) + Math.floor((k - 1) / s) * median;
  return raw <= 0 ? 0 : Math.ceil((raw - 1e-9) / 5) * 5;
}

const defaultPrint = (line: string): void => { process.stderr.write(`${line}\n`); };

export class MachineStore {
  readonly file: string;
  readonly db: DatabaseSync;
  private depth = 0;
  private syntheticNow?: Date;

  constructor(file: string = machineStorePath()) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if (this.db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') this.db.exec('PRAGMA journal_mode=WAL');
    const schema = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    const version = schema ? this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version as number | null : undefined;
    if (version && version > 1) { this.db.close(); throw new Error(t('Machine store schema {version} is newer than this program supports.', { version })); }
    if (version === 1) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const current = this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version as number | null;
      if (current && current > 1) throw new Error(t('Machine store schema {version} is newer than this program supports.', { version: current }));
      if (!current) {
        this.db.exec(`
          CREATE TABLE leases (
            resource TEXT NOT NULL,
            project TEXT NOT NULL,
            state_dir TEXT NOT NULL,
            tag TEXT NOT NULL COLLATE NOCASE,
            run TEXT,
            since TEXT NOT NULL,
            expires TEXT NOT NULL,
            pid INTEGER,
            started_at TEXT,
            unverified INTEGER NOT NULL DEFAULT 0,
            every_minutes REAL,
            kind TEXT NOT NULL CHECK(kind IN ('dispatch','acceptance','tool','nightly')),
            heartbeat_at TEXT NOT NULL,
            PRIMARY KEY (resource, project, tag)
          );
          CREATE INDEX leases_resource ON leases(resource);
          CREATE TABLE waiters (
            resource TEXT NOT NULL,
            project TEXT NOT NULL,
            tag TEXT NOT NULL COLLATE NOCASE,
            priority TEXT NOT NULL CHECK(priority IN ('rework','new')),
            enqueued_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            PRIMARY KEY (resource, project, tag)
          );
          CREATE INDEX waiters_resource ON waiters(resource);
          CREATE TABLE holds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resource TEXT NOT NULL,
            project TEXT NOT NULL,
            tag TEXT NOT NULL,
            minutes REAL NOT NULL,
            ended_at TEXT NOT NULL
          );
          CREATE INDEX holds_resource_ended ON holds(resource, ended_at DESC, id DESC);
          CREATE TABLE declared (
            resource TEXT NOT NULL,
            project TEXT NOT NULL,
            slots INTEGER NOT NULL CHECK(slots >= 1),
            seen_at TEXT NOT NULL,
            PRIMARY KEY (resource, project)
          );
          INSERT INTO schema_version VALUES (1);
        `);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  transaction<T>(change: () => T): T {
    if (this.depth) return change();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = change();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  noteNow(now: Date): void {
    this.syntheticNow = Math.abs(Date.now() - now.getTime()) > 5_000 ? new Date(now.getTime()) : undefined;
  }

  effectiveNow(now?: Date): Date {
    if (now) {
      this.noteNow(now);
      return now;
    }
    return this.syntheticNow ?? new Date();
  }

  private toLease(row: Record<string, unknown>): MachineLeaseRow {
    return {
      resource: row.resource as string,
      project: row.project as string,
      state_dir: row.state_dir as string,
      tag: row.tag as string,
      ...(row.run !== null && row.run !== undefined ? { run: row.run as string } : {}),
      since: row.since as string,
      expires: row.expires as string,
      ...(row.pid !== null && row.pid !== undefined ? { pid: Number(row.pid) } : {}),
      ...(row.started_at !== null && row.started_at !== undefined ? { started_at: row.started_at as string } : {}),
      ...(Number(row.unverified) ? { unverified: true } : {}),
      ...(row.every_minutes !== null && row.every_minutes !== undefined ? { every_minutes: Number(row.every_minutes) } : {}),
      kind: row.kind as MachineLeaseKind,
      heartbeat_at: row.heartbeat_at as string,
    };
  }

  allLeases(): MachineLeaseRow[] {
    return this.db.prepare('SELECT * FROM leases ORDER BY since ASC, rowid ASC').all().map(r => this.toLease(r));
  }

  projectLeases(projectId: string): MachineLeaseRow[] {
    return this.db.prepare('SELECT * FROM leases WHERE project = ? ORDER BY since ASC, rowid ASC').all(projectId).map(r => this.toLease(r));
  }

  leasesFor(resources: readonly string[]): MachineLeaseRow[] {
    if (!resources.length) return [];
    const marks = resources.map(() => '?').join(', ');
    return this.db.prepare(`SELECT * FROM leases WHERE resource IN (${marks}) ORDER BY since ASC, rowid ASC`).all(...resources).map(r => this.toLease(r));
  }

  waitersFor(resource: string): MachineWaiterRow[] {
    const rows = this.db.prepare(`
      SELECT resource, project, tag, priority, enqueued_at, heartbeat_at
      FROM waiters
      WHERE resource = ?
      ORDER BY CASE WHEN priority = 'rework' THEN 0 ELSE 1 END ASC, enqueued_at ASC, rowid ASC
    `).all(resource);
    return rows.map((row, index) => ({
      resource: row.resource as string,
      project: row.project as string,
      tag: row.tag as string,
      priority: row.priority as WaiterPriority,
      enqueued_at: row.enqueued_at as string,
      heartbeat_at: row.heartbeat_at as string,
      position: index + 1,
    }));
  }

  recoverStaleInTx(now: Date, checkActive: (row: MachineLeaseRow, now: Date) => boolean, options?: { print?: (line: string) => void; everyMinutes?: number }): MachineLeaseRow[] {
    const removed: MachineLeaseRow[] = [];
    const print = options?.print ?? defaultPrint;
    const delLease = this.db.prepare('DELETE FROM leases WHERE resource = ? AND project = ? AND tag = ?');
    for (const row of this.allLeases()) {
      let stale = false;
      if (row.pid !== undefined) {
        stale = !checkActive(row, now);
      } else if (row.kind !== 'dispatch') {
        stale = true;
      } else {
        const limitMinutes = Math.max(30, 3 * (row.every_minutes ?? options?.everyMinutes ?? 0));
        stale = now.getTime() - Date.parse(row.heartbeat_at) > limitMinutes * 60_000;
      }
      if (!stale) continue;
      delLease.run(row.resource, row.project, row.tag);
      removed.push(row);
      print(`[machine] recovered stale ${row.kind} lease on ${row.resource} held by ${row.project}:${row.tag}${row.pid !== undefined ? ` (pid ${row.pid})` : ''}`);
    }
    const delWaiter = this.db.prepare('DELETE FROM waiters WHERE resource = ? AND project = ? AND tag = ?');
    for (const w of this.db.prepare('SELECT resource, project, tag, heartbeat_at FROM waiters').all()) {
      if (now.getTime() - Date.parse(w.heartbeat_at as string) > WAITER_STALE_MS) {
        delWaiter.run(w.resource as string, w.project as string, w.tag as string);
      }
    }
    return removed;
  }

  recoverStale(now: Date, checkActive: (row: MachineLeaseRow, now: Date) => boolean, options?: { print?: (line: string) => void; everyMinutes?: number }): MachineLeaseRow[] {
    this.noteNow(now);
    return this.transaction(() => this.recoverStaleInTx(now, checkActive, options));
  }

  syncDeclaredInTx(project: ProjectConfig, now: Date): void {
    const machineEntries = Object.entries(project.resources ?? {}).filter(([, r]) => r.scope === 'machine');
    const seenAt = now.toISOString();
    const put = this.db.prepare(`
      INSERT INTO declared(resource, project, slots, seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource, project) DO UPDATE SET slots = excluded.slots, seen_at = excluded.seen_at
    `);
    for (const [name, r] of machineEntries) put.run(name, project.id, r.slots, seenAt);
    const keep = new Set(machineEntries.map(([name]) => name));
    const del = this.db.prepare('DELETE FROM declared WHERE project = ? AND resource = ?');
    for (const row of this.db.prepare('SELECT resource FROM declared WHERE project = ?').all(project.id)) {
      const res = row.resource as string;
      if (!keep.has(res)) del.run(project.id, res);
    }
  }

  declarationsOf(resource: string, fallbackSlots: number, now: Date): { effectiveSlots: number; declarations: { project: string; slots: number }[]; mismatch?: string } {
    const activeProjects = new Set<string>([
      ...this.db.prepare('SELECT project FROM leases WHERE resource = ?').all(resource).map(r => r.project as string),
      ...this.db.prepare('SELECT project FROM waiters WHERE resource = ?').all(resource).map(r => r.project as string),
    ]);
    const rows = this.db.prepare('SELECT project, slots, seen_at FROM declared WHERE resource = ? ORDER BY project ASC').all(resource);
    const live = rows
      .filter(r => activeProjects.has(r.project as string) || now.getTime() - Date.parse(r.seen_at as string) <= DECLARATION_LIVE_MS)
      .map(r => ({ project: r.project as string, slots: Number(r.slots) }));
    if (!live.length) return { effectiveSlots: fallbackSlots, declarations: [] };
    const effectiveSlots = Math.min(...live.map(d => d.slots));
    const distinct = new Set(live.map(d => d.slots));
    const mismatch = distinct.size > 1
      ? `${resource}: ${live.map(d => `${d.project} says ${d.slots}`).join(', ')}; using ${effectiveSlots}`
      : undefined;
    return { effectiveSlots, declarations: live, ...(mismatch ? { mismatch } : {}) };
  }

  upsertLeaseInTx(row: MachineLeaseRow): void {
    this.db.prepare(`
      INSERT INTO leases(resource, project, state_dir, tag, run, since, expires, pid, started_at, unverified, every_minutes, kind, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource, project, tag) DO UPDATE SET
        state_dir = excluded.state_dir,
        run = COALESCE(excluded.run, leases.run),
        expires = excluded.expires,
        pid = COALESCE(excluded.pid, leases.pid),
        started_at = COALESCE(excluded.started_at, leases.started_at),
        unverified = excluded.unverified,
        every_minutes = COALESCE(excluded.every_minutes, leases.every_minutes),
        heartbeat_at = excluded.heartbeat_at
    `).run(
      row.resource, row.project, row.state_dir, row.tag,
      row.run ?? null, row.since, row.expires,
      row.pid ?? null, row.started_at ?? null, row.unverified ? 1 : 0,
      row.every_minutes ?? null, row.kind, row.heartbeat_at,
    );
  }

  touchDispatchLeaseInTx(resource: string, project: string, tag: string, nowIso: string, patch?: { run?: string; pid?: number | null; started_at?: string | null; every_minutes?: number }): void {
    const current = this.db.prepare('SELECT * FROM leases WHERE resource = ? AND project = ? AND tag = ?').get(resource, project, tag);
    if (!current) return;
    const pid = patch && 'pid' in patch ? (patch.pid ?? null) : (current.pid as number | null);
    const startedAt = patch && 'started_at' in patch ? (patch.started_at ?? null) : (current.started_at as string | null);
    const run = patch?.run !== undefined ? patch.run : (current.run as string | null);
    const every = patch?.every_minutes !== undefined ? patch.every_minutes : (current.every_minutes as number | null);
    this.db.prepare('UPDATE leases SET run = ?, pid = ?, started_at = ?, every_minutes = ?, heartbeat_at = ? WHERE resource = ? AND project = ? AND tag = ?')
      .run(run, pid, startedAt, every, nowIso, resource, project, tag);
  }

  recordHoldInTx(resource: string, project: string, tag: string, minutes: number, endedAt: string): void {
    this.db.prepare('INSERT INTO holds(resource, project, tag, minutes, ended_at) VALUES (?, ?, ?, ?, ?)')
      .run(resource, project, tag, Math.max(0, minutes), endedAt);
    this.db.prepare(`
      DELETE FROM holds
      WHERE resource = ? AND id NOT IN (
        SELECT id FROM holds WHERE resource = ? ORDER BY ended_at DESC, id DESC LIMIT ?
      )
    `).run(resource, resource, HOLD_KEEP_LIMIT);
  }

  recordHold(resource: string, project: string, tag: string, minutes: number, endedAt: string): void {
    this.transaction(() => this.recordHoldInTx(resource, project, tag, minutes, endedAt));
  }

  holdsFor(resource: string, limit = HOLD_KEEP_LIMIT): MachineHoldRow[] {
    return this.db.prepare('SELECT id, resource, project, tag, minutes, ended_at FROM holds WHERE resource = ? ORDER BY ended_at DESC, id DESC LIMIT ?')
      .all(resource, limit)
      .map(r => ({ id: Number(r.id), resource: r.resource as string, project: r.project as string, tag: r.tag as string, minutes: Number(r.minutes), ended_at: r.ended_at as string }));
  }

  medianHoldMinutes(resource: string): number | undefined {
    const rows = this.db.prepare('SELECT minutes FROM holds WHERE resource = ? ORDER BY ended_at DESC, id DESC LIMIT ?')
      .all(resource, HOLD_MEDIAN_SAMPLE);
    if (rows.length < HOLD_MIN_SAMPLE) return undefined;
    const sorted = rows.map(r => Number(r.minutes)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  removeLeaseInTx(resource: string, project: string, tag: string, now: Date, recordHold = true): { removed: MachineLeaseRow; heldMinutes: number } | undefined {
    const row = this.db.prepare('SELECT * FROM leases WHERE resource = ? AND project = ? AND tag = ?').get(resource, project, tag);
    if (!row) return undefined;
    const removed = this.toLease(row);
    this.db.prepare('DELETE FROM leases WHERE resource = ? AND project = ? AND tag = ?').run(resource, project, removed.tag);
    const heldMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(removed.since)) / 60000));
    if (recordHold) this.recordHoldInTx(resource, removed.project, removed.tag, heldMinutes, now.toISOString());
    return { removed, heldMinutes };
  }

  removeUniqueLeaseByTagInTx(resource: string, tag: string, now: Date, recordHold = true): { removed: MachineLeaseRow; heldMinutes: number } | undefined {
    const rows = this.db.prepare('SELECT * FROM leases WHERE resource = ? AND tag = ?').all(resource, tag);
    if (rows.length !== 1) return undefined;
    const target = this.toLease(rows[0]);
    return this.removeLeaseInTx(resource, target.project, target.tag, now, recordHold);
  }

  removeWaiterInTx(resource: string, project: string, tag: string): void {
    this.db.prepare('DELETE FROM waiters WHERE resource = ? AND project = ? AND tag = ?').run(resource, project, tag);
  }

  refreshProjectWaitersInTx(projectId: string, wanted: readonly { resource: string; tag: string; priority: WaiterPriority }[], now: Date): void {
    const nowIso = now.toISOString();
    const put = this.db.prepare(`
      INSERT INTO waiters(resource, project, tag, priority, enqueued_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource, project, tag) DO UPDATE SET
        priority = excluded.priority,
        heartbeat_at = excluded.heartbeat_at
    `);
    for (const w of wanted) put.run(w.resource, projectId, w.tag, w.priority, nowIso, nowIso);
    const wantedKeys = new Set(wanted.map(w => `${w.resource}\0${w.tag.toLowerCase()}`));
    const del = this.db.prepare('DELETE FROM waiters WHERE resource = ? AND project = ? AND tag = ?');
    for (const row of this.db.prepare('SELECT resource, tag FROM waiters WHERE project = ?').all(projectId)) {
      const res = row.resource as string, tag = row.tag as string;
      if (!wantedKeys.has(`${res}\0${tag.toLowerCase()}`)) del.run(res, projectId, tag);
    }
  }
}

const connections = new Map<string, MachineStore>();
const byStateDir = new Map<string, MachineStoreContext>();
const byObject = new WeakMap<ProjectConfig, MachineStoreContext>();

export function bindProjectMachineStore(project: ProjectConfig, ctx: MachineStoreContext): void {
  const normalized: MachineStoreContext = {
    ...(ctx.file ? { file: path.resolve(ctx.file) } : {}),
    ...(ctx.everyMinutes !== undefined ? { everyMinutes: ctx.everyMinutes } : {}),
    ...(ctx.print ? { print: ctx.print } : {}),
  };
  byObject.set(project, normalized);
  byStateDir.set(path.resolve(project.state_dir), normalized);
}

export function unbindProjectMachineStore(project: ProjectConfig): void {
  byObject.delete(project);
  byStateDir.delete(path.resolve(project.state_dir));
}

export function projectMachineContext(project: ProjectConfig): MachineStoreContext | undefined {
  return byObject.get(project) ?? byStateDir.get(path.resolve(project.state_dir));
}

export function machineStoreAt(file: string = machineStorePath()): MachineStore {
  const key = path.resolve(file);
  let store = connections.get(key);
  if (!store) {
    store = new MachineStore(key);
    connections.set(key, store);
  }
  return store;
}

export function existingMachineStore(file: string = machineStorePath()): MachineStore | undefined {
  const key = path.resolve(file);
  const open = connections.get(key);
  if (open) return open;
  if (!existsSync(key)) return undefined;
  return machineStoreAt(key);
}

export function machineStoreFor(project: ProjectConfig): MachineStore {
  const ctx = projectMachineContext(project);
  return machineStoreAt(ctx?.file ?? machineStorePath());
}

export function closeMachineStores(): void {
  for (const store of connections.values()) store.close();
  connections.clear();
}
