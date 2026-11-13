import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { processStartedAt } from '../monitor/process.ts';

/**
 * A lock file that names its owner: process, machine, when the process started and a token of its own. Recovering a stale
 * lock (its process is gone, or its pid now belongs to another process) is safe against two waiters doing it at once: a
 * waiter removes the lock only under a short second lock (`<file>.break`), and only when the file still holds the owner it
 * judged stale. Another waiter's fresh lock is never removed, and release removes the file only while it still holds our token.
 */
export interface LockOwner { pid: number; host: string; started: string; token: string; at: string }

/** How long a lock can be held before its pid is checked for reuse (looking up a start time is slow). */
const REUSE_CHECK_AFTER_MS = 30_000;
/** A break lock is held for a few reads; one older than this was left by a process that died while holding it. */
const BREAK_STALE_MS = 10_000;
/** A lock file that cannot be read (an older format cut short) counts as stale after this long. */
const UNREADABLE_STALE_MS = 10_000;

const selfStarted = new Date(Date.now() - process.uptime() * 1000).toISOString();

export interface LockProbes {
  alive(pid: number): boolean;
  /** The OS start time of a process, when it can be found. */
  startedAt(pid: number): string | undefined;
  host: string;
  now(): number;
}

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const defaultProbes: LockProbes = { alive: defaultAlive, startedAt: processStartedAt, host: hostname(), now: () => Date.now() };

/** Creates the file with its whole content at once: written under a temporary name, then linked into place (fails if it exists). */
function createWhole(file: string, content: string): boolean {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, 'utf8');
  try {
    try { linkSync(temp, file); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      // A file system without hard links: an exclusive create (a reader may then see the file before its content).
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes(code ?? '')) throw error;
      try { writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); return true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    }
  } finally { rmSync(temp, { force: true }); }
}

function readRaw(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** The owner a lock file names; an older lock that holds only a pid is read as a local owner. */
export function lockOwner(raw: string): Partial<LockOwner> | undefined {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return { pid: Number(text) };
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    return parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid) && parsed.pid! > 0 ? parsed : undefined;
  } catch { return undefined; }
}

/** Is the lock left by a process that no longer holds it? A lock from another machine is never judged here. */
function isStale(file: string, raw: string, probes: LockProbes): boolean {
  const owner = lockOwner(raw);
  if (!owner) {
    try { return probes.now() - statSync(file).mtimeMs > UNREADABLE_STALE_MS; } catch { return false; }
  }
  if (owner.host && owner.host !== probes.host) return false;
  if (!probes.alive(owner.pid!)) return true;
  // The pid is alive: it may have been reused. Checked only for a lock held unusually long.
  const heldSince = Date.parse(owner.at ?? '');
  if (!owner.started || !Number.isFinite(heldSince) || probes.now() - heldSince < REUSE_CHECK_AFTER_MS) return false;
  const actual = Date.parse(probes.startedAt(owner.pid!) ?? '');
  return Number.isFinite(actual) && Math.abs(actual - Date.parse(owner.started)) > 5000;
}

/** Removes a stale lock under the break lock, only while the file still holds what was judged stale. */
function breakStale(file: string, seen: string, probes: LockProbes): void {
  const breaker = `${file}.break`;
  if (!createWhole(breaker, JSON.stringify({ pid: process.pid, host: probes.host, at: new Date(probes.now()).toISOString() }))) {
    try { if (probes.now() - statSync(breaker).mtimeMs > BREAK_STALE_MS) rmSync(breaker, { force: true }); } catch { /* released meanwhile */ }
    return;
  }
  try {
    if (readRaw(file) === seen && isStale(file, seen, probes)) rmSync(file, { force: true });
  } finally { rmSync(breaker, { force: true }); }
}

/**
 * One attempt to take the lock. Returns its release, or undefined when another live owner holds it (a stale owner is cleared
 * first, so the next attempt can take it).
 */
export function tryLock(file: string, probes: LockProbes = defaultProbes): (() => void) | undefined {
  const owner: LockOwner = { pid: process.pid, host: probes.host, started: selfStarted, token: randomUUID(), at: new Date(probes.now()).toISOString() };
  const content = JSON.stringify(owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createWhole(file, content)) {
      return () => { if (readRaw(file) === content) rmSync(file, { force: true }); };
    }
    const seen = readRaw(file);
    if (seen === undefined) continue; // released meanwhile
    if (!isStale(file, seen, probes)) return undefined;
    breakStale(file, seen, probes);
  }
  return undefined;
}

/** Is the lock held by a live owner right now? */
export function lockHeld(file: string, probes: LockProbes = defaultProbes): boolean {
  const raw = readRaw(file);
  return raw !== undefined && !isStale(file, raw, probes);
}
