import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type * as A from '../api/types.ts';
import { loadProject, type ProjectConfig } from '../config.ts';
import { UserError, fail, t } from '../i18n.ts';
import { acceptanceLeaseActive, machineLeaseProcessActive, readLeases } from '../resources/leases.ts';
import { existingMachineStore } from '../resources/machine-store.ts';
import { spawnDetachedProgram } from '../run/spawn.ts';
import { keyDir, keyFile, readKeyFile } from '../web/auth.ts';
import { loadWorkers, type WorkersFile } from '../workers/config.ts';
import { lockHolder } from './lock.ts';
import type { Serve } from './coordinator.ts';

export const DEFAULT_DRAIN_SECONDS = 120;
export const TAKEOVER_TIMEOUT_MS = 60_000;
export const PREPARE_TIMEOUT_MS = 60_000;
export const WATCH_CODE_DEBOUNCE_MS = 10_000;
export const SMOKE_TIMEOUT_MS = 60_000;

export interface ServeHandover {
  from: number;
  from_started: string;
  to?: number;
  to_started?: string;
  port?: number;
  state: 'starting' | 'ready' | 'released' | 'done' | 'failed';
  started_at: string;
  closed_at?: string;
  listening_at?: string;
  gap_ms?: number;
  why?: string;
}

export interface ReloadRuntimeOptions {
  entry?: string;
  argv?: string[];
  execPath?: string;
  execArgv?: string[];
  cwd?: string;
  logFile?: string;
  watchCode?: boolean;
  watchDebounceMs?: number;
  drainSeconds?: number;
  exitOnRelease?: boolean;
}

export interface ReloadHost {
  readonly startedAt: string;
  readonly projects: readonly ProjectConfig[];
  readonly workers: WorkersFile;
  readonly everyMinutes: number;
  readonly maxDispatch: number;
  readonly signIn: boolean;
  readonly extraOrigins: readonly string[];
  port(): number | undefined;
  isStopped(): boolean;
  notice(
    kind: 'reload-started' | 'reload-refused' | 'reload-failed' | 'reload-done',
    text: string,
    extra?: { from?: number; to?: number; gapMs?: number },
  ): void;
  drainAndRelease(drainSeconds: number): Promise<string>;
}

export interface ReloadController {
  trigger(request: A.ServeReloadRequest): Promise<A.ServeReloadResult>;
  close(): void;
}

export const handoverFile = (stateDir: string): string => path.join(stateDir, 'serve-handover.json');

export function writeHandover(file: string, record: ServeHandover): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(record) + '\n';
  try {
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, payload, 'utf8');
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

export function readHandover(file: string): ServeHandover | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ServeHandover;
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.from) || typeof parsed.state !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function createServeLogger(logPath?: string): { logFile?: string; print: (line: string) => void } {
  if (!logPath) {
    return { print: line => console.log(line) };
  }
  const resolved = path.resolve(logPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  return {
    logFile: resolved,
    print: line => {
      mkdirSync(path.dirname(resolved), { recursive: true });
      appendFileSync(resolved, `${line}\n`, 'utf8');
    },
  };
}

/** Leases held by this serve process (acceptance or tool jobs) across local and machine-wide stores. */
export function heldReloadLeases(projects: readonly ProjectConfig[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (label: string) => {
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  };
  for (const project of projects) {
    let local;
    try { local = readLeases(project); } catch { continue; }
    for (const lease of local) {
      const a = lease.acceptance;
      if (!a || a.pid !== process.pid || a.nightly || a.measurement) continue;
      if (!acceptanceLeaseActive(lease)) continue;
      const kind = a.kind === 'tool' ? 'tool' : 'acceptance';
      const name = a.cap ?? lease.resource;
      add(`${kind} lease ${name} (${project.id}:${lease.tag})`);
    }
  }
  try {
    const store = existingMachineStore();
    if (store) {
      for (const row of store.allLeases()) {
        if ((row.kind !== 'acceptance' && row.kind !== 'tool') || row.pid !== process.pid) continue;
        if (!machineLeaseProcessActive(row)) continue;
        add(`${row.kind} lease ${row.resource} (${row.project}:${row.tag})`);
      }
    }
  } catch { /* machine store unavailable */ }
  return out;
}

export interface CodeLayout {
  codeRoot: string;
  treeDir: string;
  srcDir: string;
  ext: '.ts' | '.js';
  entry: string;
}

export function resolveCodeLayout(rawEntry?: string, cwd = process.cwd()): CodeLayout {
  const fallbackServeDir = fileURLToPath(new URL('.', import.meta.url));
  const fallbackTreeDir = path.dirname(fallbackServeDir);
  const fallbackRoot = path.dirname(fallbackTreeDir);
  const fallbackExt: '.ts' | '.js' = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const defaultEntry = path.join(fallbackTreeDir, 'cli', `main${fallbackExt}`);
  const entry = rawEntry ? path.resolve(cwd, rawEntry) : defaultEntry;
  const parentName = path.basename(path.dirname(entry));
  if (parentName === 'bin') {
    const codeRoot = path.dirname(path.dirname(entry));
    const hasTs = existsSync(path.join(codeRoot, 'src', 'cli', 'main.ts'));
    const ext: '.ts' | '.js' = hasTs ? '.ts' : '.js';
    const treeDir = path.join(codeRoot, hasTs ? 'src' : 'dist');
    return { codeRoot, treeDir, srcDir: path.join(codeRoot, 'src'), ext, entry };
  }
  if (parentName === 'cli') {
    const treeDir = path.dirname(path.dirname(entry));
    const codeRoot = path.dirname(treeDir);
    const ext: '.ts' | '.js' = entry.endsWith('.js') ? '.js' : '.ts';
    return { codeRoot, treeDir, srcDir: path.join(codeRoot, 'src'), ext, entry };
  }
  return { codeRoot: fallbackRoot, treeDir: fallbackTreeDir, srcDir: path.join(fallbackRoot, 'src'), ext: fallbackExt, entry };
}

/**
 * Child 2 of the reload smoke: `src/serve/worker.ts` has top-level side effects (`parentPort!`, `workerData.entry` and
 * `startCoordinator(...)`), so we strip/parse `worker.ts` (and `read-worker.ts`) for syntax and dynamically import all of
 * `worker.ts`'s dependencies.
 */
const WORKER_DEPS_SCRIPT = `
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mod from 'node:module';

const { workerFile, readWorkerFile, depUrls } = JSON.parse(process.argv[1]);
const urls = new Set(depUrls);
for (const file of [workerFile, readWorkerFile]) {
  if (!file || !existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.ts') && typeof mod.stripTypeScriptTypes === 'function') {
    mod.stripTypeScriptTypes(source);
  }
  if (file === workerFile) {
    const re = /(?:import|export)\\s+(?!type\\s)(?:[^'"]*?\\s+from\\s+)?['"](\\.\\.?\\/[^'"]+)['"]/g;
    for (const match of source.matchAll(re)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      if (existsSync(resolved)) urls.add(pathToFileURL(resolved).href);
    }
  }
}
for (const url of urls) {
  await import(url);
}
`;

function runExecFile(
  program: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const errObj = error as { code?: unknown; killed?: boolean; signal?: string; message?: string };
        const timedOut = Boolean(errObj.killed) || errObj.signal === 'SIGTERM';
        const code = typeof errObj.code === 'number' ? errObj.code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || (errObj.message ?? ''), timedOut });
      },
    );
  });
}

function summarizeChildFailure(label: string, res: { code: number; stdout: string; stderr: string; timedOut: boolean }, timeoutMs: number): string {
  if (res.timedOut) return `${label} timed out after ${Math.round(timeoutMs / 1000)}s`;
  const lines = `${res.stderr}\n${res.stdout}`
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('(Use `node --trace-warnings') && !l.includes('ExperimentalWarning:'));
  const errLine = lines.find(l => /\b[A-Za-z]*Error\b|ERR_|Cannot find/i.test(l));
  const locLine = lines.find(l => /:\d+(?::\d+)?$/.test(l) && !l.startsWith('node:internal/'));
  const picked = [locLine, errLine].filter((x): x is string => Boolean(x));
  const detail = (picked.length ? picked : lines.slice(0, 3)).join(' | ') || `exit ${res.code}`;
  return `${label} failed (exit ${res.code}): ${detail}`;
}

function sanitizeExecArgv(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '--input-type') {
      i++;
      continue;
    }
    if (a.startsWith('--eval=') || a.startsWith('--print=') || a.startsWith('--input-type=')) continue;
    out.push(a);
  }
  return out;
}

export async function runCodeSmoke(options: {
  execPath?: string;
  execArgv?: string[];
  entry?: string;
  cwd?: string;
  timeoutMs?: number;
} = {}): Promise<{ ok: true; durationMs: number } | { ok: false; durationMs: number; why: string }> {
  const started = Date.now();
  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const layout = resolveCodeLayout(options.entry ?? process.argv[1], cwd);
  const rawExecArgv = sanitizeExecArgv(options.execArgv ?? process.execArgv);
  const childExecArgv = rawExecArgv.includes('--disable-warning=ExperimentalWarning')
    ? [...rawExecArgv]
    : ['--disable-warning=ExperimentalWarning', ...rawExecArgv];

  const workerFile = path.join(layout.treeDir, 'serve', `worker${layout.ext}`);
  const readWorkerFile = path.join(layout.treeDir, 'web', `read-worker${layout.ext}`);
  const workerDepPaths = [
    path.join(layout.treeDir, 'serve', `coordinator${layout.ext}`),
    path.join(layout.treeDir, 'tick', `gather${layout.ext}`),
    path.join(layout.treeDir, 'web', `server${layout.ext}`),
    path.join(layout.treeDir, 'tick', `execute${layout.ext}`),
    path.join(layout.treeDir, 'run', `finish${layout.ext}`),
    path.join(layout.treeDir, 'orders', `service${layout.ext}`),
    path.join(layout.treeDir, 'orders', `backend${layout.ext}`),
    path.join(layout.treeDir, 'i18n' + layout.ext),
    path.join(layout.treeDir, 'web', `snapshot${layout.ext}`),
    path.join(layout.treeDir, 'serve', `fleet${layout.ext}`),
  ].filter(p => existsSync(p));
  const depUrls = workerDepPaths.map(p => pathToFileURL(p).href);

  const [helpRes, workerRes] = await Promise.all([
    runExecFile(execPath, [...rawExecArgv, layout.entry, '--help'], { cwd, timeoutMs }),
    runExecFile(
      execPath,
      [...childExecArgv, '--input-type=module', '-e', WORKER_DEPS_SCRIPT, JSON.stringify({ workerFile, readWorkerFile, depUrls })],
      { cwd, timeoutMs },
    ),
  ]);
  const durationMs = Date.now() - started;

  if (helpRes.timedOut || helpRes.code !== 0) {
    return { ok: false, durationMs, why: summarizeChildFailure('--help', helpRes, timeoutMs) };
  }
  if (!helpRes.stdout.includes('Alba - local work orders and worker orchestration')) {
    return { ok: false, durationMs, why: '--help did not print the Alba help header' };
  }
  if (workerRes.timedOut || workerRes.code !== 0) {
    return { ok: false, durationMs, why: summarizeChildFailure('worker dependencies', workerRes, timeoutMs) };
  }
  return { ok: true, durationMs };
}

export function currentGitBranch(codeRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: codeRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function checkGitReadyForReload(codeRoot: string, expectedBranch: string | undefined): { ok: true } | { ok: false; why: string } {
  if (!expectedBranch) {
    return { ok: false, why: 'serve started on a detached HEAD, so --watch-code cannot verify the checked-out branch' };
  }
  const branch = currentGitBranch(codeRoot);
  if (!branch) {
    return { ok: false, why: `HEAD is detached (serve started on branch "${expectedBranch}")` };
  }
  if (branch !== expectedBranch) {
    return { ok: false, why: `git branch changed from "${expectedBranch}" to "${branch}"` };
  }
  let gitDir: string;
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: codeRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    gitDir = path.resolve(codeRoot, raw);
  } catch {
    return { ok: false, why: 'could not inspect git directory state' };
  }
  const markers: [string, string][] = [
    ['MERGE_HEAD', 'a git merge is in progress (MERGE_HEAD)'],
    ['rebase-merge', 'a git rebase is in progress (rebase-merge)'],
    ['rebase-apply', 'a git rebase or patch apply is in progress (rebase-apply)'],
    ['CHERRY_PICK_HEAD', 'a git cherry-pick is in progress (CHERRY_PICK_HEAD)'],
    ['REVERT_HEAD', 'a git revert is in progress (REVERT_HEAD)'],
    ['BISECT_LOG', 'a git bisect is in progress (BISECT_LOG)'],
  ];
  for (const [name, label] of markers) {
    if (existsSync(path.join(gitDir, name))) {
      return { ok: false, why: label };
    }
  }
  return { ok: true };
}

export function rebuildServeArgs(
  rawArgs: readonly string[],
  opts: { port: number; takeover: string; logFile?: string },
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === '--takeover' || arg === '--port' || arg === '--log') {
      i++;
      continue;
    }
    if (arg.startsWith('--takeover=') || arg.startsWith('--port=') || arg.startsWith('--log=')) {
      continue;
    }
    out.push(arg);
  }
  if (!out.includes('serve')) out.unshift('serve');
  out.push('--port', String(opts.port));
  if (opts.logFile) out.push('--log', opts.logFile);
  out.push('--takeover', opts.takeover);
  return out;
}

const reloadEnvPath = (fromPid: number, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(keyDir(env), `reload-env-${fromPid}.json`);

function writeReloadEnvFile(fromPid: number, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const dir = keyDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = reloadEnvPath(fromPid, env);
    const tmp = `${file}.${process.pid}.tmp`;
    const record: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && k !== 'ALBA_HANDOVER_FILE') record[k] = v;
    }
    writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    return file;
  } catch {
    return undefined;
  }
}

function restoreReloadEnv(fromPid: number): void {
  const file = reloadEnvPath(fromPid, process.env);
  try {
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && k !== 'ALBA_HANDOVER_FILE') process.env[k] = v;
    }
  } catch { /* best-effort */ } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

function cleanEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split(/\r?\n/)[0]?.trim() || 'unknown error';
}

function removeQuietly(file: string | undefined): void {
  if (!file) return;
  try { rmSync(file, { force: true }); } catch { /* best-effort */ }
}

function readLogTailReason(logFile: string): string | undefined {
  try {
    if (!existsSync(logFile)) return undefined;
    const size = statSync(logFile).size;
    if (!size) return undefined;
    const text = readFileSync(logFile, 'utf8').slice(-4096);
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.at(-1);
  } catch {
    return undefined;
  }
}

function buildFallbackServeArgs(host: ReloadHost): string[] {
  const args: string[] = [
    'serve',
    '--every', String(host.everyMinutes),
    '--max-dispatch', String(host.maxDispatch),
  ];
  for (const p of host.projects) args.push('--project', p.file);
  if (host.workers.file) args.push('--workers', host.workers.file);
  if (host.signIn) args.push('--sign-in');
  for (const o of host.extraOrigins) args.push('--allow-origin', o);
  return args;
}

export function attachServeReload(host: ReloadHost, runtime: ReloadRuntimeOptions = {}): ReloadController {
  const execPath = runtime.execPath ?? process.execPath;
  const execArgv = runtime.execArgv ? [...runtime.execArgv] : [...process.execArgv];
  const cwd = runtime.cwd ?? process.cwd();
  const layout = resolveCodeLayout(runtime.entry, cwd);
  const drainSeconds = runtime.drainSeconds ?? DEFAULT_DRAIN_SECONDS;
  const watchDebounceMs = runtime.watchDebounceMs ?? WATCH_CODE_DEBOUNCE_MS;

  let reloading = false;
  let closed = false;
  let watcher: FSWatcher | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let watchSeq = 0;
  let activeEnvFile: string | undefined;

  const closeWatcher = () => {
    if (watchTimer) {
      clearTimeout(watchTimer);
      watchTimer = undefined;
    }
    if (watcher) {
      try { watcher.close(); } catch { /* best-effort */ }
      watcher = undefined;
    }
  };

  const close = () => {
    closed = true;
    closeWatcher();
    removeQuietly(activeEnvFile);
    activeEnvFile = undefined;
  };

  const superviseHandover = async (
    childPid: number,
    hFile: string,
    startedAtIso: string,
    actualPort: number,
    childLog: string,
    envFile: string | undefined,
  ): Promise<void> => {
    const prepareDeadline = Date.now() + PREPARE_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < prepareDeadline) {
      if (closed || host.isStopped()) {
        removeQuietly(envFile);
        return;
      }
      const h = readHandover(hFile);
      if (h && h.from === process.pid && h.from_started === host.startedAt) {
        if (h.state === 'failed') {
          removeQuietly(envFile);
          activeEnvFile = undefined;
          reloading = false;
          const why = h.why ?? `new serve (pid ${h.to ?? childPid}) failed during preparation`;
          host.notice('reload-failed', t('Reload failed: {why}', { why }), { from: process.pid, to: h.to ?? childPid });
          return;
        }
        if (h.state === 'ready') {
          ready = true;
          break;
        }
      }
      if (!isPidAlive(childPid)) {
        const afterExit = readHandover(hFile);
        const why = (afterExit?.from === process.pid && afterExit.from_started === host.startedAt && afterExit.why)
          ? afterExit.why
          : readLogTailReason(childLog) ?? `new serve (pid ${childPid}) exited before ready`;
        if (afterExit?.state !== 'failed') {
          writeHandover(hFile, {
            from: process.pid,
            from_started: host.startedAt,
            to: childPid,
            port: actualPort,
            state: 'failed',
            started_at: startedAtIso,
            why,
          });
        }
        removeQuietly(envFile);
        activeEnvFile = undefined;
        reloading = false;
        host.notice('reload-failed', t('Reload failed: {why}', { why }), { from: process.pid, to: childPid });
        return;
      }
      await sleep(25);
    }

    removeQuietly(envFile);
    activeEnvFile = undefined;

    if (!ready) {
      const why = `new serve (pid ${childPid}) did not reach ready within ${Math.round(PREPARE_TIMEOUT_MS / 1000)}s`;
      writeHandover(hFile, {
        from: process.pid,
        from_started: host.startedAt,
        to: childPid,
        port: actualPort,
        state: 'failed',
        started_at: startedAtIso,
        why,
      });
      try { process.kill(childPid); } catch { /* best-effort */ }
      reloading = false;
      host.notice('reload-failed', t('Reload failed: {why}', { why }), { from: process.pid, to: childPid });
      return;
    }

    // Step 4: New serve is ready; stop code watching, drain old serve, release locks & port, mark released, and exit 0.
    closeWatcher();
    const closedAt = await host.drainAndRelease(drainSeconds);
    const current = readHandover(hFile);
    writeHandover(hFile, {
      from: process.pid,
      from_started: host.startedAt,
      to: current?.to ?? childPid,
      ...(current?.to_started ? { to_started: current.to_started } : {}),
      port: actualPort,
      state: 'released',
      started_at: startedAtIso,
      closed_at: closedAt,
    });
    if (runtime.exitOnRelease) {
      process.exit(0);
    }
  };

  const triggerInternal = async (
    request: A.ServeReloadRequest,
    opts?: { abortIfChanged?: () => boolean },
  ): Promise<A.ServeReloadResult | undefined> => {
    if (closed || host.isStopped()) {
      const reason = t('A reload is already in progress (pid {pid}).', { pid: process.pid });
      throw new UserError(reason);
    }
    if (reloading) {
      const reason = t('A reload is already in progress (pid {pid}).', { pid: process.pid });
      host.notice('reload-refused', reason, { from: process.pid });
      throw new UserError(reason);
    }
    const actualPort = host.port();
    if (!actualPort) {
      const reason = t('Reload refused: {why}', { why: 'server is not listening yet' });
      host.notice('reload-refused', reason, { from: process.pid });
      throw new UserError(reason);
    }
    if (!host.projects.length) {
      const reason = t('Reload refused: {why}', { why: 'no project configured' });
      host.notice('reload-refused', reason, { from: process.pid });
      throw new UserError(reason);
    }

    reloading = true;
    try {
      if (!request.force) {
        const held = heldReloadLeases(host.projects);
        if (held.length) {
          reloading = false;
          const reason = t('Reload refused: {leases} held by this serve (pid {pid}). Pass --force to reload anyway.', {
            leases: held.join(', '),
            pid: process.pid,
          });
          host.notice('reload-refused', reason, { from: process.pid });
          throw new UserError(reason);
        }
      }

      const smoke = await runCodeSmoke({ execPath, execArgv, entry: layout.entry, cwd });
      if (closed || host.isStopped()) {
        reloading = false;
        throw new UserError(t('Reload refused: {why}', { why: 'serve stopped' }));
      }
      if (opts?.abortIfChanged?.()) {
        reloading = false;
        return undefined;
      }
      if (!smoke.ok) {
        reloading = false;
        const reason = t('Reload refused: code smoke failed: {why}', { why: smoke.why });
        host.notice('reload-refused', reason, { from: process.pid });
        throw new UserError(reason);
      }

      const firstStateDir = host.projects[0]!.state_dir;
      const hFile = handoverFile(firstStateDir);
      const startedAtIso = new Date().toISOString();
      writeHandover(hFile, {
        from: process.pid,
        from_started: host.startedAt,
        port: actualPort,
        state: 'starting',
        started_at: startedAtIso,
      });

      const envFile = writeReloadEnvFile(process.pid, process.env);
      activeEnvFile = envFile;
      const baseArgs = runtime.argv ?? buildFallbackServeArgs(host);
      const serveArgs = rebuildServeArgs(baseArgs, {
        port: actualPort,
        takeover: `${process.pid}:${host.startedAt}`,
        logFile: runtime.logFile,
      });
      const childLog = runtime.logFile ?? path.join(firstStateDir, 'serve.log');
      let childPid: number;
      try {
        childPid = spawnDetachedProgram(execPath, [...execArgv, layout.entry, ...serveArgs], {
          cwd,
          env: { ...cleanEnvRecord(process.env), ALBA_HANDOVER_FILE: hFile },
          envUnset: [],
          logFile: childLog,
        });
      } catch (err) {
        removeQuietly(envFile);
        activeEnvFile = undefined;
        const why = cleanErrorMessage(err);
        writeHandover(hFile, {
          from: process.pid,
          from_started: host.startedAt,
          port: actualPort,
          state: 'failed',
          started_at: startedAtIso,
          why,
        });
        reloading = false;
        const msg = t('Reload failed: {why}', { why });
        host.notice('reload-failed', msg, { from: process.pid });
        throw new UserError(msg);
      }

      host.notice(
        'reload-started',
        t('Reloading alba serve (pid {from} -> pid {to}) on port {port}...', {
          from: process.pid,
          to: childPid,
          port: actualPort,
        }),
        { from: process.pid, to: childPid },
      );
      void superviseHandover(childPid, hFile, startedAtIso, actualPort, childLog, envFile);
      return { from: process.pid, state: 'starting' };
    } catch (err) {
      reloading = false;
      throw err;
    }
  };

  if (runtime.watchCode && existsSync(layout.srcDir)) {
    const initialBranch = currentGitBranch(layout.codeRoot);
    const scheduleWatchReload = () => {
      if (closed || host.isStopped()) return;
      const seq = ++watchSeq;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = undefined;
        if (closed || host.isStopped() || reloading) return;
        const gitReady = checkGitReadyForReload(layout.codeRoot, initialBranch);
        if (!gitReady.ok) {
          host.notice('reload-refused', t('Reload refused: {why}', { why: gitReady.why }), { from: process.pid });
          return;
        }
        void triggerInternal({ force: false }, { abortIfChanged: () => watchSeq !== seq }).catch(() => {
          /* refusal notice already emitted; keep watching for the next change */
        });
      }, watchDebounceMs);
      watchTimer.unref();
    };

    try {
      watcher = watch(layout.srcDir, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        scheduleWatchReload();
      });
      watcher.on('error', () => { /* keep serve running if fs.watch reports an error */ });
    } catch { /* src/ watch unavailable */ }
  }

  return {
    async trigger(request: A.ServeReloadRequest): Promise<A.ServeReloadResult> {
      const res = await triggerInternal(request);
      return res ?? { from: process.pid, state: 'starting' };
    },
    close,
  };
}

/** Resolves the first project's state_dir even when the project YAML was edited invalidly after serve started. */
export function resolveReloadStateDir(file: string): string {
  try {
    return loadProject(file).state_dir;
  } catch (err) {
    const resolvedFile = path.resolve(file);
    const base = path.dirname(resolvedFile);
    if (existsSync(resolvedFile)) {
      const rawText = readFileSync(resolvedFile, 'utf8');
      try {
        const parsed = parseYaml(rawText) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object' && typeof parsed.state_dir === 'string' && parsed.state_dir.trim()) {
          return path.resolve(base, parsed.state_dir.trim());
        }
      } catch { /* fall back to line scan */ }
      const match = /^state_dir\s*:\s*["']?([^"'\r\n#]+)["']?/m.exec(rawText);
      if (match?.[1]?.trim()) {
        return path.resolve(base, match[1].trim());
      }
    }
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(base, entry.name);
        if (lockHolder(candidate)) return candidate;
      }
    } catch { /* ignore */ }
    throw err;
  }
}

export function parseTakeoverFlag(value: string): { fromPid: number; fromStarted: string } {
  const colon = value.indexOf(':');
  if (colon <= 0 || colon >= value.length - 1) {
    fail('Invalid --takeover "{value}"; expected <pid>:<started>.', { value });
  }
  const fromPid = Number(value.slice(0, colon));
  const fromStarted = value.slice(colon + 1);
  if (!Number.isInteger(fromPid) || fromPid <= 0 || !fromStarted.trim()) {
    fail('Invalid --takeover "{value}"; expected <pid>:<started>.', { value });
  }
  return { fromPid, fromStarted };
}

export interface TakeoverServeParams {
  takeover: string;
  projectFiles: () => string[];
  workersOption?: string;
  portOption?: string;
  everyOption?: string;
  maxDispatchOption?: string;
  drainSecondsOption?: string;
  allowOrigin?: string[];
  signIn: boolean;
  watchCode: boolean;
  logOption?: string;
  rawArgv: string[];
  startServeFn: (options: import('./coordinator.ts').ServeOptions) => Serve & { emitReloadDone?: (from: number, gapMs: number) => void };
  registerSignals: (serve: Serve) => void;
  onListeningBanner: (port: number, every: number, token: string) => void;
}

export async function runTakeoverServe(params: TakeoverServeParams): Promise<string> {
  const { fromPid, fromStarted } = parseTakeoverFlag(params.takeover);
  const envHandoverFile = process.env.ALBA_HANDOVER_FILE ? path.resolve(process.env.ALBA_HANDOVER_FILE) : undefined;
  delete process.env.ALBA_HANDOVER_FILE;
  restoreReloadEnv(fromPid);

  const logger = createServeLogger(params.logOption);
  const myStartedAt = new Date().toISOString();

  let projects: ProjectConfig[];
  let workers: WorkersFile;
  let port: number;
  let every: number;
  let maxDispatch: number;
  let drainSeconds: number;
  let hFile: string | undefined = envHandoverFile;

  try {
    port = params.portOption === undefined ? 4777 : Number(params.portOption);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('--port must be a port number.');
    every = params.everyOption === undefined ? 15 : Number(params.everyOption);
    if (!Number.isFinite(every) || every < 0) fail('--every must be a number of minutes (0 turns the tick loop off).');
    maxDispatch = params.maxDispatchOption === undefined ? 1 : Number(params.maxDispatchOption);
    if (!Number.isInteger(maxDispatch) || maxDispatch < 0) fail('--max-dispatch must be a whole number >= 0.');
    drainSeconds = params.drainSecondsOption === undefined ? DEFAULT_DRAIN_SECONDS : Number(params.drainSecondsOption);
    if (!Number.isFinite(drainSeconds) || drainSeconds < 0) fail('--drain-seconds must be a number of seconds >= 0.');

    const files = params.projectFiles();
    if (!hFile && files[0]) {
      try { hFile = handoverFile(resolveReloadStateDir(files[0])); } catch { /* resolved below via loadProject */ }
    }
    projects = files.map(file => loadProject(file));
    hFile ??= handoverFile(projects[0]!.state_dir);

    const workersPath = params.workersOption ?? process.env.ALBA_WORKERS ?? projects.find(p => p.workers)?.workers;
    if (!workersPath) fail('alba serve needs a workers file: --workers, ALBA_WORKERS or "workers:" in the project file.');
    workers = loadWorkers(workersPath);

    // Preload coordinator and probes modules before signalling ready so takeover needs no cold module load.
    const { systemProbes } = await import('../tick/gather.ts');
    void systemProbes;

    const existing = readHandover(hFile);
    writeHandover(hFile, {
      from: fromPid,
      from_started: fromStarted,
      to: process.pid,
      to_started: myStartedAt,
      port,
      state: 'ready',
      started_at: existing?.from === fromPid ? existing.started_at : myStartedAt,
    });
  } catch (err) {
    const why = cleanErrorMessage(err);
    if (hFile) {
      const existing = readHandover(hFile);
      writeHandover(hFile, {
        from: fromPid,
        from_started: fromStarted,
        to: process.pid,
        to_started: myStartedAt,
        state: 'failed',
        started_at: existing?.from === fromPid ? existing.started_at : myStartedAt,
        why,
      });
    }
    logger.print(`alba serve takeover preflight failed: ${why}`);
    throw err;
  }

  // Wait for the old serve to drain and write `state: "released"` (or exit).
  const waitReleaseDeadline = Date.now() + (Math.max(drainSeconds, DEFAULT_DRAIN_SECONDS) + 60) * 1000;
  let releasedSeenMs = Date.now();
  while (Date.now() < waitReleaseDeadline) {
    const h = readHandover(hFile);
    if (h && h.from === fromPid && h.from_started === fromStarted) {
      if (h.state === 'failed') {
        fail('Reload failed: {why}', { why: h.why ?? 'aborted by previous serve' });
      }
      if (h.state === 'released') {
        releasedSeenMs = Date.now();
        break;
      }
    }
    if (!isPidAlive(fromPid)) {
      releasedSeenMs = Date.now();
      break;
    }
    await sleep(20);
  }
  if (isPidAlive(fromPid)) {
    const h = readHandover(hFile);
    if (!h || h.state !== 'released') {
      const why = `previous serve (pid ${fromPid}) did not release within drain window`;
      writeHandover(hFile, {
        from: fromPid,
        from_started: fromStarted,
        to: process.pid,
        to_started: myStartedAt,
        port,
        state: 'failed',
        started_at: h?.started_at ?? myStartedAt,
        why,
      });
      logger.print(t('Takeover failed after 60s: {why}', { why }));
      fail('Takeover failed after 60s: {why}', { why });
    }
  }

  // Step 5: Take locks and listen on the same port within 60 s.
  const { systemProbes } = await import('../tick/gather.ts');
  const takeoverDeadline = Date.now() + TAKEOVER_TIMEOUT_MS;
  let lastError = 'port or lock unavailable';
  let activeServe: (Serve & { emitReloadDone?: (from: number, gapMs: number) => void }) | undefined;

  while (Date.now() < takeoverDeadline) {
    const busy = projects.map(p => lockHolder(p.state_dir)).find(Boolean);
    if (busy) {
      lastError = `serve lock still held by pid ${busy.pid}`;
      await sleep(25);
      continue;
    }
    try {
      const candidate = params.startServeFn({
        projects,
        workers,
        port,
        probes: systemProbes,
        everyMinutes: every,
        maxDispatch,
        print: logger.print,
        extraOrigins: params.allowOrigin,
        signIn: params.signIn,
        version: '0.1.0',
        takeoverAttempt: true,
        reload: {
          entry: process.argv[1],
          argv: params.rawArgv,
          execPath: process.execPath,
          execArgv: process.execArgv,
          cwd: process.cwd(),
          logFile: logger.logFile,
          watchCode: params.watchCode,
          drainSeconds,
          exitOnRelease: true,
        },
      });
      const listened = await new Promise<{ ok: true } | { ok: false; why: string }>(resolve => {
        const onListen = () => {
          candidate.server.off('error', onErr);
          resolve({ ok: true });
        };
        const onErr = (e: Error) => {
          candidate.server.off('listening', onListen);
          resolve({ ok: false, why: e.message });
        };
        candidate.server.once('listening', onListen);
        candidate.server.once('error', onErr);
      });
      if (listened.ok) {
        activeServe = candidate;
        break;
      }
      lastError = listened.why;
      await Promise.resolve(candidate.stop());
    } catch (err) {
      lastError = cleanErrorMessage(err);
    }
    await sleep(40);
  }

  if (!activeServe) {
    const existing = readHandover(hFile);
    writeHandover(hFile, {
      from: fromPid,
      from_started: fromStarted,
      to: process.pid,
      to_started: myStartedAt,
      port,
      state: 'failed',
      started_at: existing?.started_at ?? myStartedAt,
      why: lastError,
    });
    const msg = t('Takeover failed after 60s: {why}', { why: lastError });
    logger.print(msg);
    fail('Takeover failed after 60s: {why}', { why: lastError });
  }

  const listeningMs = Date.now();
  const latest = readHandover(hFile);
  const closedMs = latest?.closed_at && Number.isFinite(Date.parse(latest.closed_at))
    ? Date.parse(latest.closed_at)
    : releasedSeenMs;
  const gapMs = Math.max(0, listeningMs - closedMs);
  const actualPort = (activeServe.server.address() as AddressInfo).port;

  writeHandover(hFile, {
    from: fromPid,
    from_started: fromStarted,
    to: process.pid,
    to_started: activeServe.startedAt ?? myStartedAt,
    port: actualPort,
    state: 'done',
    started_at: latest?.started_at ?? myStartedAt,
    ...(latest?.closed_at ? { closed_at: latest.closed_at } : {}),
    listening_at: new Date(listeningMs).toISOString(),
    gap_ms: gapMs,
  });

  params.registerSignals(activeServe);
  params.onListeningBanner(actualPort, every, activeServe.board.ctx.token);
  activeServe.emitReloadDone?.(fromPid, gapMs);

  return new Promise<string>(() => { /* foreground serve stays alive until stopped or reloaded */ });
}

export interface ServeReloadCliParams {
  projectFiles: string[];
  portOption?: string;
  force: boolean;
  waitOption?: string;
}

export async function runServeReloadCli(params: ServeReloadCliParams): Promise<{ ok: boolean; message: string }> {
  const waitSeconds = params.waitOption === undefined ? 90 : Number(params.waitOption);
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
    fail('--wait must be a number of seconds above 0.');
  }
  const explicitPort = params.portOption === undefined ? undefined : Number(params.portOption);
  if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort <= 0 || explicitPort > 65535)) {
    fail('--port must be a port number.');
  }

  const stateDir = resolveReloadStateDir(params.projectFiles[0]!);
  const holder = lockHolder(stateDir);
  if (!holder) {
    return { ok: false, message: t('No running alba serve holds {dir}.', { dir: stateDir }) };
  }
  const port = explicitPort ?? holder.port;
  if (!port) {
    return { ok: false, message: t('Serve lock in {dir} (pid {pid}) has no port yet; pass --port <N>.', { dir: stateDir, pid: holder.pid }) };
  }
  if (explicitPort !== undefined && holder.port !== undefined && explicitPort !== holder.port) {
    return { ok: false, message: t('Serve lock in {dir} is on port {actual}, not {given}.', { dir: stateDir, actual: holder.port, given: explicitPort }) };
  }

  const keyRec = readKeyFile(port);
  if (!keyRec) {
    return { ok: false, message: t('Could not read console key file for port {port} ({file}).', { port, file: keyFile(port) }) };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  const fetchTimeoutMs = Math.max(5_000, Math.min(waitSeconds * 1000, SMOKE_TIMEOUT_MS + 15_000));
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/serve/reload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-alba-token': keyRec.key,
      },
      body: JSON.stringify(params.force ? { force: true } : {}),
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch (err) {
    return { ok: false, message: t('Reload failed: {why}', { why: cleanErrorMessage(err) }) };
  }

  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* non-JSON */ }

  if (response.status !== 202) {
    const errField = body.error;
    const msg = typeof errField === 'string'
      ? errField
      : (errField && typeof errField === 'object' && typeof (errField as { message?: unknown }).message === 'string')
        ? (errField as { message: string }).message
        : `HTTP ${response.status}`;
    return { ok: false, message: msg };
  }

  const fromPid = typeof body.from === 'number' ? body.from : holder.pid;
  const hFile = handoverFile(stateDir);
  let lastState = 'starting';

  while (Date.now() < deadline) {
    const h = readHandover(hFile);
    if (h && h.from === fromPid && h.from_started === holder.started) {
      lastState = h.state;
      if (h.state === 'failed') {
        const why = h.why ?? 'unknown failure';
        return { ok: false, message: t('Reload failed: {why}', { why }) };
      }
      if (h.state === 'done') {
        // Ensure the old OS process handle has fully exited before returning to the caller.
        while (isPidAlive(fromPid) && Date.now() < deadline) {
          await sleep(20);
        }
        const gapMs = h.gap_ms ?? 0;
        const toPid = h.to ?? lockHolder(stateDir)?.pid ?? 0;
        return {
          ok: true,
          message: t('Reloaded alba serve on port {port}: pid {from} -> pid {to} (gap {gap} ms).', {
            port,
            from: fromPid,
            to: toPid,
            gap: gapMs,
          }),
        };
      }
    }
    await sleep(40);
  }

  return {
    ok: false,
    message: t('Reload timed out after {seconds}s (last state: {state}).', { seconds: waitSeconds, state: lastState }),
  };
}
