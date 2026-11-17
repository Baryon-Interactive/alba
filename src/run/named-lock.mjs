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
const ordinal = n => {
  const m100 = Math.abs(n) % 100, m10 = Math.abs(n) % 10;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return m10 === 1 ? `${n}st` : m10 === 2 ? `${n}nd` : m10 === 3 ? `${n}rd` : `${n}th`;
};
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
const readLiveQueue = (queueDir, now = Date.now()) => {
  if (!existsSync(queueDir)) return [];
  const entries = readdirSync(queueDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.tmp') && !e.name.endsWith('.break'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const e of entries) {
    const qFile = path.join(queueDir, e.name), raw = readRaw(qFile);
    if (raw === undefined) continue;
    if (isStale(qFile, raw)) { breakStale(qFile, raw); continue; }
    const q = parse(raw);
    if (!q) continue;
    const since = q.since ?? new Date(statSync(qFile).mtimeMs).toISOString();
    out.push({
      file: qFile,
      position: out.length + 1,
      pid: q.pid,
      ...(q.host ? { host: q.host } : {}),
      ...(q.run ? { run: q.run } : {}),
      ...(q.command ? { command: q.command } : {}),
      ...(q.cwd ? { cwd: q.cwd } : {}),
      since,
      waitMinutes: Math.max(0, Math.round((now - Date.parse(since)) / 60000)),
    });
  }
  return out;
};

export function listNamedLocks(now = Date.now()) {
  const dir = lockDirectory(); if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.lock') && !e.name.endsWith('.break')).flatMap(e => {
    const file = path.join(dir, e.name), raw = readRaw(file); if (raw === undefined) return [];
    const name = e.name.slice(0, -5);
    const holder = parse(raw), since = holder?.since ?? new Date(statSync(file).mtimeMs).toISOString();
    const queue = readLiveQueue(path.join(dir, `${name}.queue`), now).map(({ file: _file, ...item }) => item);
    return [{
      name,
      holder: holder?.pid,
      host: holder?.host,
      ...(holder?.run ? { run: holder.run } : {}),
      command: holder?.command,
      cwd: holder?.cwd,
      since,
      heldMinutes: Math.max(0, Math.round((now - Date.parse(since)) / 60000)),
      stale: isStale(file, raw),
      queue,
    }];
  });
}

export async function runNamedLock(argv) {
  const split = argv.indexOf('--'), head = split < 0 ? argv : argv.slice(0, split), command = split < 0 ? [] : argv.slice(split + 1), name = head[0], waitAt = head.indexOf('--wait-minutes'), waitMinutes = waitAt >= 0 ? Number(head[waitAt + 1]) : 60;
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || !command.length || !Number.isFinite(waitMinutes) || waitMinutes < 0) return 2;
  const dir = lockDirectory(), file = path.join(dir, `${name}.lock`), queueDir = path.join(dir, `${name}.queue`);
  mkdirSync(queueDir, { recursive: true });
  const token = randomUUID(), started = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const cmdText = command.join(' ').slice(0, 300), run = process.env.ALBA_RUN || undefined;
  const enqueuedIso = new Date().toISOString();
  const queueFile = path.join(queueDir, `${enqueuedIso.replace(/:/g, '-')}-${process.pid}-${token}.json`);
  const queuePayload = JSON.stringify({ pid: process.pid, host, started, token, ...(run ? { run } : {}), cwd: process.cwd(), command: cmdText, since: enqueuedIso });
  createWhole(queueFile, queuePayload);

  let queueRemoved = false, stopping = false, child, wakeWait;
  const removeQueue = () => { if (queueRemoved) return; queueRemoved = true; try { rmSync(queueFile, { force: true }); } catch {} };
  const onSignal = signal => {
    if (stopping) return;
    stopping = true;
    removeQueue();
    if (wakeWait) wakeWait();
    if (child) {
      try { child.kill(signal); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref();
    }
  };
  process.once('exit', removeQueue);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  const detachSignals = () => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal); };

  const deadline = Date.now() + waitMinutes * 60000;
  let toldWho = '', toldPos = 0, content = '';
  for (;;) {
    if (stopping) { removeQueue(); detachSignals(); return 130; }
    if (!queueRemoved && !existsSync(queueFile)) { mkdirSync(queueDir, { recursive: true }); createWhole(queueFile, queuePayload); }
    const live = readLiveQueue(queueDir);
    const idx = live.findIndex(e => e.file === queueFile);
    const pos = idx >= 0 ? idx + 1 : live.length + 1;
    if (pos === 1) {
      content = JSON.stringify({ pid: process.pid, host, started, token, ...(run ? { run } : {}), cwd: process.cwd(), command: cmdText, since: new Date().toISOString() });
      if (createWhole(file, content)) { removeQueue(); break; }
      const seen = readRaw(file);
      if (seen === undefined) continue;
      if (isStale(file, seen)) { breakStale(file, seen); continue; }
    } else {
      const seen = readRaw(file);
      if (seen !== undefined && isStale(file, seen)) breakStale(file, seen);
    }
    const seen = readRaw(file);
    if (pos !== toldPos) { process.stderr.write(`[lock] waiting for "${name}" (${ordinal(pos)} in queue)\n`); toldPos = pos; }
    if (seen !== undefined) {
      const h = parse(seen), who = h ? `pid ${h.pid}${h.run ? ` (${h.run})` : ''} in ${h.cwd} since ${h.since}` : 'another run';
      if (who !== toldWho) { process.stderr.write(`[lock] waiting for the "${name}" lock, held by ${who}\n`); toldWho = who; }
    }
    if (Date.now() > deadline) { removeQueue(); detachSignals(); process.stderr.write(`[lock] gave up after ${waitMinutes} minutes\n`); return 75; }
    await new Promise(resolve => {
      const timer = setTimeout(() => { wakeWait = undefined; resolve(); }, 200);
      wakeWait = () => { clearTimeout(timer); wakeWait = undefined; resolve(); };
    });
  }

  const release = () => { removeQueue(); try { if (readRaw(file) === content) rmSync(file, { force: true }); } catch {} };
  process.once('exit', release);
  if (stopping) { release(); detachSignals(); return 130; }
  return new Promise(resolve => {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: false });
    if (stopping) { try { child.kill('SIGTERM'); } catch {} }
    child.on('error', error => { process.stderr.write(`[lock] ${error.message}\n`); release(); detachSignals(); resolve(1); });
    child.on('exit', code => { release(); detachSignals(); resolve(stopping ? 130 : code ?? 1); });
  });
}

export const usage = () => 'usage: alba lock <name> [--wait-minutes 60] -- <program> [arguments...]';
