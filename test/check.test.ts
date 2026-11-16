import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adopt, compare, flatten, loadRefs, mergeResults, parseResults, saveRefs, type Refs } from '../src/check/refs.ts';
import { generalChecks, globToRegExp } from '../src/check/general.ts';
import { formatCheck, runCheck } from '../src/check/check.ts';
import { validateProject } from './state-helper.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tickLoop, type Round } from '../src/tick/loop.ts';
import { waitFor, type WaitDeps } from '../src/wait/wait.ts';
import { tempOrders } from './helpers.ts';

const PARSER = String.raw`^(?<name>[A-Za-z][A-Za-z0-9_]*)(?=[: ])|"(?:final_)?hash":\s*"(?<value>[0-9a-f]{16})"`;

const MAIN = [
  '15:06:14', 'build exit=0', '100% tests passed, 0 tests failed out of 337',
  'soak "final_hash": "1111111111111111" ',
  'po1: "hash": "aaaaaaaaaaaaaaaa"  "passed": true ',
  'ar1: "hash": "b000000000000001" "hash": "b000000000000002" "hash": "b000000000000003"  "passed": true ',
  'po2: "hash": "cccccccccccccccc"  "passed": true ',
  'kp1: "hash": "dddddddddddddddd"  "passed": true ',
  'ws1: "hash": "eeeeeeeeeeeeeeee"  "passed": true ',
  'cp1: "hash": "ffffffffffffffff"  "passed": true ',
  '',
].join('\n');
const PARALLEL = MAIN.replace('aaaaaaaaaaaaaaaa', '0a0a0a0a0a0a0a0a').replace(/^po2: .*$/m, 'po2:  ').replace(/^kp1: .*$/m, 'kp1:  ').replace(/^ws1: .*$/m, 'ws1:  ') + 'zz9: "hash": "9999999999999999"\n';
const RERUN = 'po2: "hash": "cccccccccccccccc"  "passed": true \nkp1: "hash": "0d0d0d0d0d0d0d0d"  "passed": true \nws1: "hash": "eeeeeeeeeeeeeeee"  "passed": true \n';

const refsOf = (text: string): Refs => Object.fromEntries([...flatten(parseResults(PARSER, text))].map(([k, v]) => [k, { value: v, source: 'main', updated: 'then' }]));

test('results: several values on one line are named name#1, name#2 in order; a name with no value is "name only"', () => {
  const parsed = parseResults(PARSER, PARALLEL);
  const flat = flatten(parsed);
  assert.equal(flat.get('soak'), '1111111111111111');
  assert.deepEqual(['ar1#1', 'ar1#2', 'ar1#3'].map(k => flat.get(k)), ['b000000000000001', 'b000000000000002', 'b000000000000003']);
  assert.ok(!flat.has('ar1'));
  assert.deepEqual([...parsed.nameOnly].sort(), ['build', 'kp1', 'po2', 'ws1']);
});

test('compare: same, different, missing (absent or name only) and new; later files replace earlier ones', () => {
  const refs = refsOf(MAIN);
  const one = compare(refs, mergeResults([{ file: '/x/parallel.txt', parsed: parseResults(PARSER, PARALLEL) }]));
  const status = (rows: ReturnType<typeof compare>) => Object.fromEntries(rows.map(r => [r.name, r.status]));
  assert.deepEqual([status(one).po1, status(one).po2, status(one).kp1, status(one).ws1, status(one).cp1, status(one).zz9, status(one)['ar1#2']], ['different', 'missing', 'missing', 'missing', 'same', 'new', 'same']);
  assert.equal(one.find(r => r.name === 'po2')!.why, 'the result names it but gives no value');
  // the rerun file replaces the empty values: po2 and ws1 are the same, kp1 is different
  const both = compare(refs, mergeResults([{ file: '/x/parallel.txt', parsed: parseResults(PARSER, PARALLEL) }, { file: '/x/rerun.txt', parsed: parseResults(PARSER, RERUN) }]));
  assert.deepEqual([status(both).po2, status(both).ws1, status(both).kp1], ['same', 'same', 'different']);
  assert.equal(both.find(r => r.name === 'kp1')!.from, 'rerun.txt');
  assert.equal(both.find(r => r.name === 'po1')!.from, 'parallel.txt');
  // the order matters: the other way round the parallel file's empty lines do not wipe the rerun's values, and its values win
  const reversed = compare(refs, mergeResults([{ file: '/x/rerun.txt', parsed: parseResults(PARSER, RERUN) }, { file: '/x/parallel.txt', parsed: parseResults(PARSER, PARALLEL) }]));
  assert.equal(status(reversed).po2, 'same');
  assert.equal(reversed.find(r => r.name === 'po1')!.status, 'different');
});

test('adopt: takes the named values (and a name\'s whole family), drops stale shapes, and keeps the others', () => {
  const refs = refsOf(MAIN);
  const next = adopt(refs, parseResults(PARSER, 'ar1: "hash": "b000000000000009"\nkp1: "hash": "0d0d0d0d0d0d0d0d"\n'), ['ar1', 'kp1'], 'accepted change', 'now');
  assert.deepEqual(next.adopted.sort(), ['ar1', 'kp1']);
  assert.equal(next.refs.kp1.value, '0d0d0d0d0d0d0d0d');
  assert.equal(next.refs.kp1.source, 'accepted change');
  assert.ok(!('ar1#1' in next.refs) && next.refs.ar1.value === 'b000000000000009');   // three values became one
  assert.equal(next.refs.po1.value, refs.po1.value);
  assert.deepEqual(adopt(refs, parseResults(PARSER, RERUN), ['nope'], 's', 'n').notFound, ['nope']);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo() {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'work-orders'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  writeFileSync(path.join(root, 'work-orders', 'T1.md'), 'order\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const wt = path.join(dir, 'game-t1');
  git(root, 'worktree', 'add', '-q', '-b', 'game-t1', wt, 'main');
  const refsFile = path.join(dir, 'refs.yaml');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  const project = (checks: Record<string, unknown>) => validateProject({
    id: 'game', name: 'Game', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' }, checks: { references: refsFile, result_parser: PARSER, ...checks },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'T1', kind: 'k', worktree: wt });
  return { orders, dir, root, wt, refsFile, project };
}

test('general checks: clean, ahead, protected and forbidden paths, text that went through a code page, big new files', () => {
  const { wt, project } = repo();
  const all = { protected_paths: ['work-orders/**'], forbidden_tracked: ['artifacts/**', '**/*.dll'], max_new_file_kb: 1 };
  const run = (checks: Record<string, unknown> = all) => generalChecks(project(checks).checks, wt, 'refs/heads/main');
  assert.deepEqual(run().map(i => [i.ok]), [[true], [false], [true], [true], [true], [true], [true]]);   // clean, but not ahead yet
  mkdirSync(path.join(wt, 'artifacts'));
  writeFileSync(path.join(wt, 'artifacts', 'x.bin'), 'x');
  writeFileSync(path.join(wt, 'work-orders', 'T1.md'), 'changed\n');
  writeFileSync(path.join(wt, 'notes.md'), 'what is this ???? broken text\nand � here\n');
  writeFileSync(path.join(wt, 'big.dat'), 'x'.repeat(3000));
  writeFileSync(path.join(wt, 'fine.md'), 'a question? and another?? fine\n');
  writeFileSync(path.join(wt, 'progress.json'), '\uFEFF{"plan":[]}\n');
  writeFileSync(path.join(wt, 'plain.json'), '{"plan":[]}\n');
  assert.equal(run()[0].ok, false);   // dirty
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'work');
  const items = Object.fromEntries(run().map(i => [i.name, i]));
  assert.ok(items['worktree is clean'].ok && items['branch is ahead of main'].ok);
  assert.match(items['protected paths are unchanged'].detail, /work-orders\/T1\.md/);
  assert.match(items['no forbidden paths added or changed'].detail, /artifacts\/x\.bin/);
  assert.match(items['added text has no "????" or U+FFFD'].detail, /notes\.md:1, notes\.md:2/);
  assert.ok(!items['added text has no "????" or U+FFFD'].detail.includes('fine.md'));   // "??" is fine, only 4 or more count
  assert.match(items['no added file over 1 KB'].detail, /big\.dat/);
  assert.equal(items['no JSON file the branch changed starts with a byte order mark'].detail, 'progress.json: write these as UTF-8 without a byte order mark');
  // every item can be switched off
  assert.deepEqual(run({ ...all, clean_worktree: false, ahead_of_base: false, encoding_scan: false }).length, 3);
  assert.ok(globToRegExp('**/*.dll').test('a/b/c.dll') && globToRegExp('**/*.dll').test('c.dll') && !globToRegExp('artifacts/*').test('artifacts/a/b') && globToRegExp('artifacts/').test('artifacts/a/b'));
});

test('check: the event is recorded on the order, the exit code follows the findings, adopt records an event and updates the file', () => {
  const { orders, wt, refsFile, project, dir } = repo();
  const cfg = project({});
  writeFileSync(path.join(wt, 'x.txt'), 'x\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'work');
  const main = path.join(dir, 'main.txt'), run1 = path.join(dir, 'run1.txt'), run2 = path.join(dir, 'run2.txt');
  writeFileSync(main, MAIN);
  // import every value from a result file (the first reference values)
  const first = adopt({}, parseResults(PARSER, readFileSync(main, 'utf8')), 'all', 'main at merge', 'then');
  saveRefs(refsFile, first.refs);
  orders.record('*', 'refs-adopt', { names: first.adopted });
  assert.equal(loadRefs(refsFile)['ar1#3'].value, 'b000000000000003');
  writeFileSync(run1, PARALLEL);
  writeFileSync(run2, RERUN);
  const report = runCheck(cfg, orders, 'T1', [run1, run2]);
  assert.equal(report.exitCode, 1);
  assert.ok(report.general.every(g => g.ok));
  const text = formatCheck(report);
  assert.match(text, /po1\s+different/);
  const event = orders.store.events({ tag: 'T1' }).filter(e => e.type === 'check').at(-1)!;
  const data = event.data as { ok: boolean; refs: { same: number; other: { name: string; status: string }[] } };
  assert.equal(data.ok, false);
  assert.deepEqual(data.refs.other.map(o => `${o.name}:${o.status}`).sort(), ['kp1:different', 'po1:different', 'zz9:new']);
  // all fine: exit 0
  const fine = runCheck(cfg, orders, 'T1', [main]);
  assert.equal(fine.exitCode, 0);
  // a bad configuration is an error, not a finding
  assert.throws(() => runCheck(project({ result_parser: '(?<a>x)' }), orders, 'T1', [main]), /named groups/);
  assert.ok(existsSync(refsFile));
});

function waitFixture(over: Partial<Probes> = {}, imported = false) {
  const { orders, dir } = tempOrders();
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: workOrders, state_dir: path.join(dir, 'state'), dispatch: { stall_minutes: 60 } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'T1', kind: 'k', worktree: path.join(dir, 'wt') });
  orders.act('T1', 'queue');
  orders.runStart('T1', imported ? { worker: 'w' } : { worker: 'w', extra: { pid: 4242, log: path.join(dir, 'T1.log') } }, imported);
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const sleeps: number[] = [];
  const probes = { now: () => new Date(), fileTime: () => undefined, readText: () => undefined, isAlive: () => true, tail: () => '', gitActivity: () => ({}), ...over } as unknown as Probes;
  const deps: WaitDeps = { now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; }, print: () => {}, git: { worktrees: () => [], facts: () => undefined } };
  return { orders, project, probes, deps, sleeps, ctx: { project, orders, workers: { workers: [], quota_sources: {}, file: '' }, probes } };
}

test('wait: ends (and records the end like a tick) when the process is gone, stalls with exit 2, times out with exit 3, polls slowly', async () => {
  // 1. the process ends with a report block: recorded, exit 0
  let alive = true;
  const block = '--- alba-report ---\n{"status":"ready","summary":"done","question":"","evidence":[],"commits":[]}\n--- end ---';
  const a = waitFixture({ isAlive: () => alive, fileTime: () => '2099-01-01T00:00:00Z', readText: () => block } as Partial<Probes>);
  a.orders.patchRun('T1', 'r1', { last_file: '/x/T1.last.txt' });
  a.deps.sleep = async (ms: number) => { a.sleeps.push(ms); alive = false; };
  const ended = await waitFor(a.ctx, 'T1', { stallMinutes: 60, pollMinutes: 2 }, a.deps);
  assert.equal(ended.exitCode, 0);
  assert.match(ended.line, /run r1 ended: completed, ready/);
  assert.equal(a.orders.stage(a.orders.get('T1')).stage, 'awaiting-review');
  assert.deepEqual(a.sleeps, [120000]);                       // one slow poll, no busy waiting
  // 2. nothing moves for longer than the limit: stalled, and the process is left alone
  const s = waitFixture({ gitActivity: () => ({ lastCommitAt: '2026-01-01T09:00:00Z' }), fileTime: () => '2026-01-01T09:30:00Z' });
  const stalled = await waitFor(s.ctx, 'T1', { stallMinutes: 60, pollMinutes: 2 }, s.deps);
  assert.equal(stalled.exitCode, 2);
  assert.match(stalled.line, /stalled/);
  assert.equal(s.orders.stage(s.orders.get('T1')).stage, 'running');
  // 3. quiet but the last command is still running: waiting, not a stall; then the timeout
  const w = waitFixture({ gitActivity: () => ({ lastCommitAt: '2026-01-01T09:00:00Z' }), fileTime: () => '2026-01-01T09:30:00Z', tail: () => 'exec\n"powershell.exe" -Command \'bash run.sh long\' in workspace/w\n' } as Partial<Probes>);
  const printed: string[] = [];
  w.deps.print = (line: string) => { printed.push(line); };
  const timedOut = await waitFor(w.ctx, 'T1', { stallMinutes: 60, timeoutMinutes: 10, pollMinutes: 2 }, w.deps);
  assert.equal(timedOut.exitCode, 3);
  assert.equal(printed.length, 1);                            // the waiting note is printed once, not at every poll
  assert.match(printed[0], /waiting for a command: bash run\.sh long/);
  assert.equal(w.sleeps.length, 5);
});

test('wait: an imported run is judged by the files and git, as sync does', async () => {
  const f = waitFixture({ gitActivity: () => ({ lastCommitAt: '2026-01-01T11:50:00Z' }) }, true);
  f.deps.git = { worktrees: () => [], facts: () => ({ dirty: 0, ahead: ['abc1234'], lastSubject: 'T1: report', lastAt: '2026-01-01T09:00:00.000Z' }) };
  (f.project.sync as { git_signal: boolean }).git_signal = true;
  const r = await waitFor(f.ctx, 'T1', { stallMinutes: 60, pollMinutes: 2 }, f.deps);
  assert.equal(r.exitCode, 0);
  assert.equal(f.orders.stage(f.orders.get('T1')).stage, 'awaiting-review');
});

test('tick --every: one line when nothing changed, the whole report when something did, a loud mark on exit 2 and 3, and it goes on', async () => {
  const rounds: Round[] = [
    { text: 'REPORT A', signature: 'a', exitCode: 0 }, { text: 'REPORT A', signature: 'a', exitCode: 0 },
    { text: 'REPORT B', signature: 'b', exitCode: 2 }, { text: 'REPORT B', signature: 'b', exitCode: 2 },
  ];
  let n = 0;
  const lines: string[] = [];
  await tickLoop(() => { if (n === 4) throw new Error('bad configuration'); return rounds[n++]; }, 5, { print: l => lines.push(l), sleep: async () => {}, clock: () => '21:34', stop: () => lines.length >= 5 });
  assert.equal(lines[0], 'REPORT A');
  assert.equal(lines[1], '21:34  nothing changed (exit 0)');
  assert.match(lines[2], /^!!! exit 2: problems !!!\nREPORT B$/);
  assert.match(lines[3], /nothing changed \(exit 2\)  !!! exit 2/);
  assert.match(lines[4], /^!!! exit 3: the tick could not run !!!\nalba: bad configuration$/);
});
