import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

export const lockDirectory = () => process.env.ALBA_LOCK_DIR || path.join(tmpdir(), 'alba-locks');
const host = hostname(), reuseChecked = new Map();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readRaw = file => { try { return readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const ageMs = file => { try { return Date.now() - statSync(file).mtimeMs; } catch { return 0; } };
const parse = raw => { try { const h = JSON.parse(raw); return h && Number.isInteger(h.pid) && h.pid > 0 ? h : undefined; } catch { return undefined; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const createWhole = (file, text) => {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, text, 'utf8');
  try {
    try { linkSync(temp, file); return true; }
    catch (e) {
      if (e.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes(e.code)) throw e;
      try { writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' }); return true; }
      catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
    }
  } finally { rmSync(temp, { force: true }); }
};
const startedAt = pid => {
  try {
    const text = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const at = Date.parse(text.trim()); return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
};
const isStale = (file, raw) => {
  const h = parse(raw); if (!h) return ageMs(file) > 10000; if (h.host && h.host !== host) return false; if (!alive(h.pid)) return true;
  const since = Date.parse(h.since ?? ''); if (!h.started || !Number.isFinite(since) || Date.now() - since < 30000) return false;
  const key = h.token ?? raw; if (Date.now() - (reuseChecked.get(key) ?? 0) < 30000) return false; reuseChecked.set(key, Date.now());
  const actual = startedAt(h.pid); return actual !== undefined && Math.abs(actual - Date.parse(h.started)) > 5000;
};
const breakStale = (file, seen) => {
  const breaker = `${file}.break`;
  if (!createWhole(breaker, JSON.stringify({ pid: process.pid, host, at: new Date().toISOString() }))) { if (ageMs(breaker) > 10000) rmSync(breaker, { force: true }); return; }
  try { if (readRaw(file) === seen) rmSync(file, { force: true }); } finally { rmSync(breaker, { force: true }); }
};

export function listNamedLocks(now = Date.now()) {
  const dir = lockDirectory(); if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.lock') && !e.name.endsWith('.break')).flatMap(e => {
    const file = path.join(dir, e.name), raw = readRaw(file); if (raw === undefined) return [];
    const holder = parse(raw), since = holder?.since ?? new Date(statSync(file).mtimeMs).toISOString();
    return [{ name: e.name.slice(0, -5), holder: holder?.pid, host: holder?.host, command: holder?.command, cwd: holder?.cwd, since, heldMinutes: Math.max(0, Math.round((now - Date.parse(since)) / 60000)), stale: isStale(file, raw) }];
  });
}

export function runNamedLock(argv) {
  const split = argv.indexOf('--'), head = split < 0 ? argv : argv.slice(0, split), command = split < 0 ? [] : argv.slice(split + 1), name = head[0], waitAt = head.indexOf('--wait-minutes'), waitMinutes = waitAt >= 0 ? Number(head[waitAt + 1]) : 60;
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || !command.length || !Number.isFinite(waitMinutes) || waitMinutes < 0) return Promise.resolve(2);
  const dir = lockDirectory(), file = path.join(dir, `${name}.lock`); mkdirSync(dir, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, host, started: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: randomUUID(), cwd: process.cwd(), command: command.join(' ').slice(0, 300), since: new Date().toISOString() });
  const deadline = Date.now() + waitMinutes * 60000; let told = '';
  for (;;) {
    if (createWhole(file, content)) break;
    const seen = readRaw(file); if (seen === undefined) continue; if (isStale(file, seen)) { breakStale(file, seen); continue; }
    const h = parse(seen), who = h ? `pid ${h.pid} in ${h.cwd} since ${h.since}` : 'another run';
    if (who !== told) { process.stderr.write(`[lock] waiting for the "${name}" lock, held by ${who}\n`); told = who; }
    if (Date.now() > deadline) { process.stderr.write(`[lock] gave up after ${waitMinutes} minutes\n`); return Promise.resolve(75); }
    sleep(2000);
  }
  const release = () => { try { if (readRaw(file) === content) rmSync(file, { force: true }); } catch {} };
  return new Promise(resolve => {
    let stopping = false; process.once('exit', release); const child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: false });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (stopping) return; stopping = true; try { child.kill(signal); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref(); });
    child.on('error', error => { process.stderr.write(`[lock] ${error.message}\n`); release(); resolve(1); }); child.on('exit', code => { release(); resolve(stopping ? 130 : code ?? 1); });
  });
}

export const usage = () => 'usage: alba lock <name> [--wait-minutes 60] -- <program> [arguments...]';
