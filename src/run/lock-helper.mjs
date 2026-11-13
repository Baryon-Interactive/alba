// Runs one command while holding a named lock of this machine, so that orders running side by side take turns at something only
// one of them may do at a time (a game window capture: two games on one desktop end up in each other's screenshots).
// Put into every worktree as .alba/bin/lock.mjs.
//
//   node .alba/bin/lock.mjs <name> [--wait-minutes 60] -- <program> [arguments...]
//
// The lock is a file in <temp>/alba-locks (ALBA_LOCK_DIR overrides it) naming its holder: pid, machine, when that process started,
// a token of its own, folder and command. It is created with its whole content at once (written aside, then linked into place), so
// a reader never sees it half written. A lock whose holder is gone is taken over: its process has ended, its pid now belongs to
// another process (checked once it has been held 30 s), or the file could not be read for 10 s. Taking over happens under a short
// second lock (`<name>.lock.break`) and only while the file still holds the holder judged gone, so two waiters never both take
// it; release removes the file only while it still holds our token. Stopping the helper stops its command before the lock goes back.
// Exits with the command's exit code; 75 when the wait ran out.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const head = split < 0 ? argv : argv.slice(0, split), command = split < 0 ? [] : argv.slice(split + 1);
const name = head[0];
const waitAt = head.indexOf('--wait-minutes');
const waitMinutes = waitAt >= 0 ? Number(head[waitAt + 1]) : 60;
if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || !command.length || !Number.isFinite(waitMinutes)) {
  process.stderr.write('usage: node lock.mjs <name> [--wait-minutes 60] -- <program> [arguments...]\n');
  process.exit(2);
}
const dir = process.env.ALBA_LOCK_DIR || path.join(tmpdir(), 'alba-locks');
const file = path.join(dir, `${name}.lock`);
mkdirSync(dir, { recursive: true });

/** A pid is checked for reuse only once its lock has been held this long (looking up a start time is slow). */
const REUSE_CHECK_AFTER_MS = 30_000;
/** A lock or break file that cannot be read for this long was left by a process that died while writing it. */
const UNREADABLE_STALE_MS = 10_000;

const host = hostname();
const content = JSON.stringify({ pid: process.pid, host, started: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: randomUUID(), cwd: process.cwd(), command: command.join(' ').slice(0, 300), since: new Date().toISOString() });

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRaw = target => { try { return readFileSync(target, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const parse = raw => { try { const h = JSON.parse(raw); return h && Number.isInteger(h.pid) && h.pid > 0 ? h : undefined; } catch { return undefined; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ageMs = target => { try { return Date.now() - statSync(target).mtimeMs; } catch { return 0; } };

/** Creates the file with its whole content at once; false when it exists. */
function createWhole(target, text) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  try {
    try { linkSync(temp, target); return true; }
    catch (e) {
      if (e.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes(e.code)) throw e;
      // A file system without hard links: an exclusive create.
      try { writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' }); return true; } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
    }
  } finally { rmSync(temp, { force: true }); }
}

/** When a process started (its OS creation time), or undefined when that cannot be read. */
function startedAt(pid) {
  try {
    const text = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const at = Date.parse(text.trim());
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

const reuseChecked = new Map();
/** Is the lock left by a holder that no longer holds it? A lock of another machine is never judged here. */
function isStale(raw) {
  const h = parse(raw);
  if (!h) return ageMs(file) > UNREADABLE_STALE_MS;
  if (h.host && h.host !== host) return false;
  if (!alive(h.pid)) return true;
  const since = Date.parse(h.since ?? '');
  if (!h.started || !Number.isFinite(since) || Date.now() - since < REUSE_CHECK_AFTER_MS) return false;
  const key = h.token ?? raw;
  if (Date.now() - (reuseChecked.get(key) ?? 0) < REUSE_CHECK_AFTER_MS) return false;
  reuseChecked.set(key, Date.now());
  const actual = startedAt(h.pid);
  return actual !== undefined && Math.abs(actual - Date.parse(h.started)) > 5000;
}

/** Removes a stale lock under the break lock, only while the file still holds what was judged stale. */
function breakStale(seen) {
  const breaker = `${file}.break`;
  if (!createWhole(breaker, JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() }))) {
    if (ageMs(breaker) > UNREADABLE_STALE_MS) rmSync(breaker, { force: true });
    return;
  }
  try { if (readRaw(file) === seen) rmSync(file, { force: true }); }
  finally { rmSync(breaker, { force: true }); }
}

const deadline = Date.now() + waitMinutes * 60000;
let told = '';
for (;;) {
  if (createWhole(file, content)) break;
  const seen = readRaw(file);
  if (seen === undefined) continue; // released meanwhile
  if (isStale(seen)) { breakStale(seen); continue; }
  const h = parse(seen);
  const who = h ? `pid ${h.pid} in ${h.cwd} since ${h.since}` : 'another run';
  if (who !== told) { process.stderr.write(`[lock] waiting for the "${name}" lock, held by ${who}\n`); told = who; }
  if (Date.now() > deadline) { process.stderr.write(`[lock] gave up after ${waitMinutes} minutes\n`); process.exit(75); }
  sleep(2000);
}

const release = () => { try { if (readRaw(file) === content) rmSync(file, { force: true }); } catch { /* the next waiter judges it */ } };
process.on('exit', release);
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: false });
let stopping = false;
// A stop of the helper stops its command first; the lock goes back once the command has ended (never while it may still run).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    try { child.kill(signal); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 10000).unref();
  });
}
child.on('error', error => { process.stderr.write(`[lock] ${error.message}\n`); release(); process.exit(1); });
child.on('exit', code => { release(); process.exit(stopping ? 130 : code ?? 1); });
