import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach } from 'node:test';
import { validateProject } from './state-helper.ts';
import { Orders } from '../src/orders/service.ts';
import { testStore } from './state-helper.ts';
import type { Probes } from '../src/tick/gather.ts';
import { createBoard, type Board } from '../src/web/server.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---------------------------------------------------------------------------------------------------- shape checks against the types

/** 'string' | 'number' | 'boolean' | 'array' | 'object' | a nested spec; a key ending in "?" may be missing. [spec] checks every item of an array. */
export type Spec = 'string' | 'number' | 'boolean' | 'array' | 'object' | { [key: string]: Spec } | [Spec];
export function shape(value: unknown, spec: Spec, at = '$'): void {
  if (Array.isArray(spec)) {
    assert.ok(Array.isArray(value), `${at} should be an array`);
    (value as unknown[]).forEach((v, i) => shape(v, spec[0], `${at}[${i}]`));
    return;
  }
  if (typeof spec === 'string') {
    if (spec === 'array') return assert.ok(Array.isArray(value), `${at} should be an array`);
    if (spec === 'object') return assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${at} should be an object`);
    return assert.equal(typeof value, spec, `${at} should be a ${spec}, got ${JSON.stringify(value)}`);
  }
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${at} should be an object`);
  const obj = value as Record<string, unknown>;
  for (const [key, sub] of Object.entries(spec)) {
    const optional = key.endsWith('?');
    const name = optional ? key.slice(0, -1) : key;
    if (obj[name] === undefined) { assert.ok(optional, `${at}.${name} is missing`); continue; }
    assert.notEqual(obj[name], null, `${at}.${name} must not be null (unknown fields are left out)`);
    shape(obj[name], sub, `${at}.${name}`);
  }
}

export const REPORT: Spec = { seq: 'number', at: 'string', status: 'string', summary: 'string', 'question?': 'string', evidence: 'array', commits: 'array' };
export const SUMMARY: Spec = { project: 'string', tag: 'string', title: 'string', kind: 'string', stage: 'string', why: 'string', needs: 'array', updated: 'string', 'report?': REPORT, 'run?': { id: 'string', key: 'string', worker: 'string', started: 'string', imported: 'boolean' }, 'spend?': { total_tokens: 'number', 'cost_usd?': 'number', estimated: 'boolean', runs_with_usage: 'number', runs_unknown: 'number', over_cap: 'boolean' }, actions: 'array' };
export const WORKER: Spec = { id: 'string', engine: 'string', paid: 'boolean', concurrency: 'number', capabilities: 'array', 'notes?': 'string', cost: 'string', enabled: 'boolean', cardOnly: 'boolean', canResume: 'boolean', available: 'boolean', reasons: 'array', running: 'number', runsToday: 'number', spendTodayUsd: 'number', overCap: 'boolean' };
export const RUN: Spec = { id: 'string', key: 'string', seq: 'number', worker: 'string', started: 'string', imported: 'boolean', hasLog: 'boolean', usage: { source: 'string' } };

// ---------------------------------------------------------------------------------------------------- fixture

const boards: Board[] = [];
// Each fixture owns polling timers; retaining old boards makes later request timing depend on earlier tests.
const closeBoards = () => { for (const b of boards.splice(0)) { b.hub.stop(); b.server.closeAllConnections(); b.server.close(); } };
afterEach(closeBoards);
// Dynamic imports inside a test register afterEach for that test's children,
// not the importing test itself. Its after hook also closes those boards.
after(closeBoards);

export interface Fixture {
  board: Board; base: string; token: string; orders: Orders; dir: string; root: string; worktree: string; spawned: { program: string; args: string[] }[];
  get(p: string, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  post(p: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  write(p: string, body: unknown): Promise<{ status: number; body: any }>;
  put(p: string, body: unknown): Promise<{ status: number; body: any }>;
}

export async function fixture(options: { now?: () => Date; populate?: boolean; uiDir?: string; extraOrigins?: string[]; second?: boolean; signIn?: boolean; project?: (dir: string, root: string) => Record<string, unknown> } = {}): Promise<Fixture> {
  const { dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'orders'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const worktree = path.join(dir, 'game-r1');
  git(root, 'worktree', 'add', '-q', '-b', 'game-r1', worktree, 'main');
  const config = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: path.join(root, 'orders'), state_dir: path.join(dir, 'state'),
    dispatch: { min_free_ram_gb: 4, worktree_parent: dir, base_ref: 'refs/heads/main' }, checks: { protected_paths: ['orders/**'] }, ...(options.project?.(dir, root) ?? {}),
  }, path.join(dir, 'alba.yaml'));
  const now = options.now ?? (() => new Date());
  const orders = new Orders(testStore(config.state_dir), () => now().toISOString());
  const spawned: { program: string; args: string[] }[] = [];
  const probes = {
    now, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [{ path: root, branch: 'main' }, { path: worktree, branch: 'game-r1' }], gitActivity: () => ({}), fileTime: () => undefined,
    isAlive: () => false, tail: (file: string, bytes: number) => { try { const t = readFileSync(file, 'utf8'); return t.slice(-bytes); } catch { return ''; } }, readText: () => undefined,
    spawnDetached: (program: string, args: string[]) => { spawned.push({ program, args }); return 4242; },
  } as unknown as Probes;
  const workers = validateWorkers({ workers: [
    { id: 'coder', engine: 'x', aliases: ['Coder'], launch: { program: 'coder', args: ['run', '{session_args}', '{prompt_file}'], session: { new: ['-s', '{session_id}'], resume: ['-r', '{session_id}'] } } },
    { id: 'editor', engine: 'claude-session' },
  ] }, 'w.yaml');
  if (options.populate !== false) {
    writeFileSync(path.join(root, 'orders', 'R1-review.md'), '# R1\nReview me.\n');
    const add = (tag: string, title: string) => orders.add({ tag, title, kind: 'sim', worker: 'Coder' });
    add('Q1', 'Waits for an answer'); orders.act('Q1', 'queue'); orders.runStart('Q1', { worker: 'coder', session: 's-1' }); orders.runEnd('Q1');
    orders.report('Q1', { status: 'waiting', summary: 's', question: 'Which tileset first?', evidence: [], commits: [] });
    add('R1', 'Waits for review'); orders.update('R1', { worktree, branch: 'game-r1' }); orders.act('R1', 'queue');
    const logFile = path.join(dir, 'R1-r1.log');
    writeFileSync(logFile, 'line 1\nline 2\nline 3\n');
    orders.runStart('R1', { worker: 'coder', extra: { log: logFile, pid: 99 } }); orders.runEnd('R1'); orders.report('R1', { status: 'ready', summary: 'did it', evidence: [], commits: ['abc1234'] });
    add('W1', 'Is running'); orders.act('W1', 'queue'); orders.runStart('W1', { worker: 'coder' });
    add('D1', 'A draft <script>alert(1)</script>');
    // the branch of R1: a text change, a rename, a binary file, a big file
    writeFileSync(path.join(worktree, 'a.txt'), 'a\nb\n');
    writeFileSync(path.join(worktree, 'new.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(path.join(worktree, 'big.txt'), 'x'.repeat(300_000) + '\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'R1: work');
  }
  const configs = options.second ? [config, validateProject({ id: 'other', name: 'Other', root, work_orders: path.join(root, 'orders'), state_dir: path.join(dir, 'state2') }, path.join(dir, 'f2.yaml'))] : [config];
  const board = createBoard({ projects: configs, workers, port: 0, probes, snapshotTtlMs: 0, uiDir: options.uiDir ?? path.join(dir, 'no-ui'), extraOrigins: options.extraOrigins, hubCheckMs: 20, signIn: options.signIn ?? true });
  boards.push(board);
  await new Promise<void>(resolve => board.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(board.server.address() as AddressInfo).port}`;
  const token = board.ctx.token;
  const send = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    // Git fixtures can block the event loop beyond the server's idle timeout;
    // do not reuse a socket whose close notification is still waiting to run.
    // Programs prove themselves with the console key in x-alba-token. Reads carry it unless a test passes its own (or '');
    // post/put are the bare calls (no key unless given), write/put with the key.
    const key: Record<string, string> = method === 'GET' ? { 'x-alba-token': token } : {};
    const r = await fetch(base + p, { method, headers: { connection: 'close', ...key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* html or empty */ }
    return { status: r.status, body: parsed as any };
  };
  return {
    board, base, token, orders, dir, root, worktree, spawned,
    get: (p, headers) => send('GET', p, undefined, headers),
    post: (p, body, headers) => send('POST', p, body, headers),
    write: (p, body) => send('POST', p, body, { 'x-alba-token': token }),
    put: (p, body) => send('PUT', p, body, { 'x-alba-token': token }),
  };
}

