import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWorktree } from '../src/tick/gather.ts';
import { planTick, type TickInput, type TickOrder, type WorkerState } from '../src/tick/plan.ts';
import { validateWorkers, type CommandQuota, type WorkerConfig } from '../src/workers/config.ts';
import { availability, balanceDrop, getPath, parseCommandQuota, type QuotaReading } from '../src/workers/quota.ts';

const NOW = new Date('2026-01-01T12:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();

const command: CommandQuota = {
  type: 'command-json', command: ['quota'], select: { field: 'provider', equals: 'p' }, windows: 'windows',
  window_fields: { name: 'name', used: 'used', resets_at: 'resetsAt' }, balance: 'balance', timeout_seconds: 5,
};
const output = JSON.stringify([
  { provider: 'p', balance: '100.5 credits', windows: [{ name: '5 hours', used: 100, resetsAt: '2026-01-01T15:00:00Z' }, { name: '7 days', used: 40, resetsAt: '2026-01-05T00:00:00Z' }] },
  { provider: 'p', windows: [{ name: '5 hours', used: 100, resetsAt: '2026-01-01T13:00:00Z' }, { name: '7 days', used: 90, resetsAt: '2026-01-04T00:00:00Z' }] },
  { provider: 'other', windows: [{ name: '5 hours', used: 0 }] },
]);

const worker = (over: Partial<WorkerConfig> = {}): WorkerConfig => ({
  id: 'w1', engine: 'codex-cli', paid: false, concurrency: 2, capabilities: [], cost: 'included', aliases: ['Codex'], enabled: true, disabled_when: [], card_only: false,
  launch: { id: 'w1', program: 'codex', args: ['exec', '{prompt_file}'], env: {}, env_unset: [] }, ...over,
});

test('quota: path reading, selection, accounts merged by the least used window', () => {
  assert.equal(getPath({ a: { b: [{ c: 7 }] } }, 'a.b[0].c'), 7);
  assert.equal(getPath({ a: 1 }, 'a.x.y'), undefined);
  const r = parseCommandQuota('s', command, output, NOW.toISOString());
  assert.equal(r.entries, 2);
  assert.deepEqual(r.windows.map(w => [w.name, w.usedPercent]), [['5 hours', 100], ['7 days', 40]]);
  assert.equal(r.windows[0].resetsAt, '2026-01-01T13:00:00Z');   // the account that recovers first
  assert.equal(r.balance?.amount, 100.5);
  assert.equal(parseCommandQuota('s', command, 'not json', NOW.toISOString()).ok, false);
  assert.equal(parseCommandQuota('s', { ...command, select: { field: 'provider', equals: 'none' } }, output, NOW.toISOString()).ok, false);
});

test('quota: a full window disables a worker until it resets; a window that already reset does not', () => {
  const reading = parseCommandQuota('s', command, output, NOW.toISOString());
  const rule = [{ window_full: '5 hours', at: 100 }];
  const off = availability(worker({ quota: 's', disabled_when: rule }), reading, [], NOW);
  assert.equal(off.available, false);
  assert.match(off.reasons[0], /"5 hours" is 100% used/);
  const later = new Date('2026-01-01T13:30:00Z');
  assert.equal(availability(worker({ quota: 's', disabled_when: rule }), reading, [], later).available, true);
  assert.equal(availability(worker({ quota: 's', disabled_when: [{ window_full: '7 days', at: 100 }] }), reading, [], NOW).available, true);
  assert.equal(availability(worker({ quota: 's', disabled_when: [{ window_full: '*', at: 100 }] }), reading, [], NOW).available, false);
  assert.equal(availability(worker({ enabled: false }), undefined, [], NOW).available, false);
  const broken = availability(worker({ quota: 's' }), { source: 's', at: '', ok: false, error: 'boom', windows: [], entries: 0 }, [], NOW);
  assert.equal(broken.available, false);
  assert.match(broken.alerts[0], /could not be read \(boom\)/);
});

test('quota: a falling balance raises an alert and disables the worker', () => {
  const at = (minutes: number, amount: number): QuotaReading => ({ source: 's', at: iso(minutes), ok: true, windows: [], entries: 1, balance: { raw: `${amount}`, amount } });
  const history = [at(60, 1000), at(30, 990)];
  assert.deepEqual(balanceDrop(history, at(0, 985))?.drop, 5);
  assert.equal(balanceDrop([], at(0, 985)), undefined);
  const rule = [{ balance_drop: 3 }];
  const hit = availability(worker({ quota: 's', disabled_when: rule }), at(0, 985), history, NOW);
  assert.equal(hit.available, false);
  assert.equal(hit.alerts.length, 1);
  const calm = availability(worker({ quota: 's', disabled_when: rule }), at(0, 988), history, NOW);
  assert.equal(calm.available, true);
  assert.deepEqual(calm.alerts, []);
  // a refill is not a drop
  assert.equal(availability(worker({ quota: 's', disabled_when: rule }), at(0, 2000), history, NOW).available, true);
});

const order = (tag: string, over: Partial<TickOrder> = {}): TickOrder => ({
  role: { id: 'default' }, tag, stage: 'queued', kind: 'sim', row: Number(tag.replace(/\D/g, '')), rework: false, resume: false, endedWithoutReport: false, ...over,
});
const state = (config: WorkerConfig, over: Partial<WorkerState> = {}): WorkerState => ({ config, available: true, reasons: [], running: 0, runsToday: 0, ...over });
const input = (over: Partial<TickInput>): TickInput => ({
  now: NOW, orders: [], activity: {}, workers: [state(worker())], caps: {}, reworkReserve: 1, alerts: [], ...over,
});

test('dispatch: queued orders go to an available worker, in table order, within its concurrency', () => {
  const r = planTick(input({ orders: [order('A3'), order('A1'), order('A2')] }));
  assert.deepEqual(r.moves.map(m => m.tag), ['A1', 'A2']);              // concurrency 2
  assert.equal(r.heldBack[0].tag, 'A3');
  assert.equal(r.exitCode, 1);
  assert.equal(planTick(input({})).exitCode, 0);
});

test('dispatch: explicit priority precedes table order while caps still limit dispatch', () => {
  const r = planTick(input({ orders: [order('A1'), order('A2', { priority: 20 }), order('A3', { priority: 10 })], caps: { sim: 1 } }));
  assert.deepEqual(r.moves.map(m => m.tag), ['A2']);
  assert.equal(r.heldBack.length, 2);
});

test('dispatch: caps count running orders by kind and heavy class; rework may use the reserved slot', () => {
  const running = [order('R1', { stage: 'running', kind: 'ue', heavy: 'core' }), order('R2', { stage: 'running', kind: 'ue' })];
  const caps = { ue: 2, core: 1 };
  const plain = planTick(input({ orders: [...running, order('Q1', { kind: 'ue' })], caps }));
  assert.deepEqual(plain.moves, []);
  assert.match(plain.heldBack[0].why, /cap for "ue" is full \(2\/2\)/);
  const rework = planTick(input({ orders: [...running, order('Q1', { kind: 'ue', rework: true })], caps }));
  assert.deepEqual(rework.moves.map(m => [m.tag, m.rework]), [['Q1', true]]);
  // the heavy class has its own limit, and the reserve is used up by one rework order
  const two = planTick(input({ orders: [...running, order('Q1', { kind: 'ue', rework: true }), order('Q2', { kind: 'ue', rework: true })], caps }));
  assert.equal(two.moves.length, 1);
  const heavy = planTick(input({ orders: [running[0], order('Q3', { kind: 'sim', heavy: 'core' })], caps }));
  assert.match(heavy.heldBack[0].why, /"core"/);
  // rework goes first even when it is later in the table
  const first = planTick(input({ orders: [order('A1'), order('A9', { rework: true })], workers: [state(worker({ concurrency: 1 }))] }));
  assert.deepEqual(first.moves.map(m => m.tag), ['A9']);
});

test('dispatch: monitoring retains kind and heavy cap slots without using worker concurrency', () => {
  const active = Array.from({ length: 6 }, (_, i) => order(`E${i}`, { stage: i < 2 ? 'running' : 'monitoring', kind: 'ue', heavy: 'core' }));
  const caps = { ue: 6, core: 6 };
  const result = planTick(input({ orders: [...active, order('Q1', { kind: 'ue' }), order('Q2', { heavy: 'core' }), order('Q3')], caps }));
  assert.deepEqual(result.heldBack.map(h => h.why), ['cap for "ue" is full (6/6)', 'cap for "core" is full (6/6)']);
  assert.deepEqual(result.moves.map(m => m.tag), ['Q3']);
  const freed = planTick(input({ orders: [...active.slice(0, 5), order('Q1', { kind: 'ue' }), order('Q2', { kind: 'ue' })], caps }));
  assert.deepEqual(freed.moves.map(m => m.tag), ['Q1']);
  assert.match(freed.heldBack[0].why, /cap for "ue" is full \(6\/6\)/);
});

test('dispatch: memory, daily limit, kinds, worker preference, cards, resume', () => {
  assert.match(planTick(input({ orders: [order('A1')], freeRamGb: 4, minFreeRamGb: 8 })).heldBack[0].why, /free memory 4\.0 GB is below 8 GB/);
  const daily = planTick(input({ orders: [order('A1')], workers: [state(worker({ daily_runs: 3 }), { runsToday: 3 })] }));
  assert.match(daily.heldBack[0].why, /limit/);
  const kinds = planTick(input({ orders: [order('A1', { kind: 'art', role: { id: 'art', requires: ['vision'] } })], workers: [state(worker({ capabilities: ['shell'] }))] }));
  assert.equal(kinds.problems[0].kind, 'no-fit');
  assert.ok(kinds.problems[0].text.includes('nobody takes role art: w1 (missing capabilities: vision)'));
  assert.equal(kinds.exitCode, 2);
  const session = worker({ id: 'sess', engine: 'claude-session', card_only: true, aliases: ['Editor session'], concurrency: 1 });
  const mixed = planTick(input({ orders: [order('A1', { workerText: 'Editor session' }), order('A2', { workerText: 'Codex' }), order('A3', { resume: true })], workers: [state(worker()), state(session)] }));
  assert.deepEqual(mixed.moves.map(m => [m.tag, m.mode, m.worker]), [['A1', 'card', 'sess'], ['A2', 'dispatch', 'w1'], ['A3', 'resume', 'w1']]);
  // every worker that could take it is unavailable: a problem for a person, not a silent wait
  const dead = planTick(input({ orders: [order('A1', { workerText: 'Codex' })], workers: [state(worker(), { available: false, reasons: ['window full'] })] }));
  assert.match(dead.problems[0].text, /nobody can take it \(w1: window full\)/);
  assert.equal(dead.exitCode, 2);
});

test('stalled runs, finished runs and runs without a report', () => {
  const running = (tag: string) => order(tag, { stage: 'running' });
  const r = planTick(input({
    orders: [running('S1'), running('S2'), running('S3'), running('S4'), order('S5', { stage: 'idle', endedWithoutReport: true }), running('S6')],
    activity: {
      S1: { worktree: 'w', lastCommitAt: iso(120), dirtyFiles: 3 },       // stalled
      S2: { worktree: 'w', lastCommitAt: iso(10) },                       // fine
      S3: { worktree: 'w', lastCommitAt: iso(120), finalFileAt: iso(5) }, // wrote its final report after the last commit
      S4: {},                                                             // no worktree: not checked
      S6: { worktree: 'w', lastCommitAt: iso(120) },                      // stalled
    },
    stallMinutes: 60,
  }));
  assert.deepEqual(r.problems.map(p => [p.kind, p.tag]), [['stalled', 'S1'], ['maybe-finished', 'S3'], ['stalled', 'S6'], ['no-report', 'S5']]);
  assert.match(r.problems[0].text, /3 uncommitted/);
  assert.deepEqual(r.notChecked, ['S4']);
  assert.equal(r.exitCode, 2);
  // a real run that started recently counts as activity even if the last commit is old
  const fresh = planTick(input({ orders: [order('S1', { stage: 'running', runStartedAt: iso(5) })], activity: { S1: { worktree: 'w', lastCommitAt: iso(300) } }, stallMinutes: 60 }));
  assert.deepEqual(fresh.problems, []);
});

test('exit codes: 0 nothing, 1 something to do, 2 problems win, quota alerts are problems', () => {
  assert.equal(planTick(input({})).exitCode, 0);
  assert.equal(planTick(input({ orders: [order('A1')] })).exitCode, 1);
  assert.equal(planTick(input({ orders: [order('A1')], alerts: ['balance fell'] })).exitCode, 2);
  assert.equal(planTick(input({ orders: [order('A1', { stage: 'awaiting-user' })] })).exitCode, 0);   // waiting for a person is listed, not a problem
  assert.equal(planTick(input({ orders: [order('A1', { stage: 'awaiting-user' })] })).needsUser[0].tags[0], 'A1');
});

test('worktree lookup: the tag must be a whole word of the folder or branch name', () => {
  const list = [{ path: '/work/proj-sg1', branch: 'sg1-siege' }, { path: '/work/proj-sg1b', branch: 'sg1b-ladders' }, { path: '/work/proj', branch: 'main' }];
  assert.equal(findWorktree('SG1B', list), '/work/proj-sg1b');
  assert.equal(findWorktree('SG1', list), '/work/proj-sg1');
  assert.equal(findWorktree('SG', list), undefined);
});

test('workers file: clear errors', () => {
  const ok = { workers: [{ id: 'a', engine: 'x', quota: 'q', disabled_when: [{ window_full: '*' }, { balance_drop: 2 }] }], quota_sources: { q: { type: 'static', unlimited: true } } };
  assert.equal(validateWorkers(ok, 'w.yaml').workers[0].disabled_when.length, 2);
  assert.throws(() => validateWorkers({ workers: [] }, 'w.yaml'), /non-empty list/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'A', engine: 'x' }] }, 'w.yaml'), /lower-case/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', quota: 'nope' }] }, 'w.yaml'), /not defined in quota_sources/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', disabled_when: [{ window_full: '*' }] }] }, 'w.yaml'), /needs a quota source/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', concurrency: 0 }] }, 'w.yaml'), /whole number >= 1/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x' }, { id: 'a', engine: 'y' }] }, 'w.yaml'), /appears twice/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', secret: 'k' }] }, 'w.yaml'), /unknown key/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x' }], quota_sources: { q: { type: 'command-json', command: 'quota --json' } } }, 'w.yaml'), /no shell is used/);
  assert.equal(validateWorkers({ workers: [{ id: 'c', engine: 'claude-session' }] }, 'w.yaml').workers[0].card_only, true);
});

test('worker names: an id in the text picks that worker only, an alias any of them; runs count against their exact id', async () => {
  const sub = worker({ id: 'codex-sub' }), paid = worker({ id: 'codex-metered' });
  const workers = [state(sub), state(paid)];
  const pick = (workerText: string) => planTick(input({ workers, orders: [order('A1', { workerText })] })).moves[0]?.worker;
  assert.equal(pick('Codex'), 'codex-sub');            // the alias names both; the first one listed wins
  assert.equal(pick('codex-metered, high'), 'codex-metered'); // the id names one
  const { ownerOf } = await import('../src/usage/spend.ts');
  assert.equal(ownerOf([sub, paid], 'codex-metered')?.id, 'codex-metered');   // not codex-sub through its "Codex" alias
  assert.equal(ownerOf([sub, paid], 'Codex(alba)')?.id, 'codex-sub');
});
