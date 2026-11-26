import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cancelJob, machineJobs, startJob, type MachineJob } from '../src/machines/jobs.ts';
import { InstallRefused, installPlan, type InstallPlan } from '../src/machines/install.ts';
import { unrealDest } from '../src/machines/engines/unreal-install.ts';
import { suggestRoles } from '../src/machines/capabilities.ts';
import { tmpDir } from './tmp.ts';

const project = () => ({ state_dir: tmpDir('alba-jobs-'), state: { backend: 'files' as const } });
const node = (code: string) => [process.execPath, '-e', code];
const plan = (steps: InstallPlan['steps'], extra: Partial<InstallPlan> = {}): InstallPlan => ({ machine: 'box', item: 'git', title: 'Git', estimate: '', notes: [], display: [], steps, ...extra });
const finished = (p: ReturnType<typeof project>, run: (end: (j: MachineJob) => void) => void) => new Promise<MachineJob>(resolve => run(resolve));

test('jobs run steps in order, stop at the first failure, accept "already installed" codes and hold the machine', async () => {
  const p = project();
  const ok = await finished(p, end => startJob(p, plan([{ label: 'one', argv: node('console.log("first")') }, { label: 'two', argv: node('process.exit(7)') }, { label: 'three', argv: node('console.log("third")') }], { ok_codes: [7] }), { onEnd: end }));
  assert.equal(ok.status, 'ok'); assert.match(ok.output, /first[\s\S]*== two[\s\S]*third/);
  const failed = await finished(p, end => {
    startJob(p, plan([{ label: 'bad', argv: node('console.error("nope"); process.exit(3)') }, { label: 'never', argv: node('console.log("never")') }]), { onEnd: end });
    assert.throws(() => startJob(p, plan([])), InstallRefused, 'one job per machine');
  });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exit_code, 3); assert.match(failed.output, /nope/); assert.doesNotMatch(failed.output, /never/);
  assert.deepEqual(machineJobs(p, 'box').map(j => j.status), ['failed', 'ok']);
});

test('a pipe step copies bytes through and counts them; a cancelled job stays cancelled', async () => {
  const p = project();
  const piped = await finished(p, end => startJob(p, plan([{ label: 'copy', pipe: { from: node('process.stdout.write("x".repeat(5000))'), to: node('let n=0; process.stdin.on("data", c => n += c.length).on("end", () => console.log("got " + n))') } }]), { onEnd: end }));
  assert.equal(piped.status, 'ok'); assert.match(piped.output, /got 5000/);
  const cancelled = await finished(p, end => {
    const job = startJob(p, plan([{ label: 'slow', argv: node('setTimeout(() => {}, 60000)') }]), { onEnd: end });
    setTimeout(() => cancelJob(p, job.id), 300);
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('install plans per OS, and every missing item names an installable item', () => {
  const win = { id: 'w', name: 'w', os: 'windows' as const, connect: { ssh: 'w' }, hardware: {}, roles: [], slots: 1, min_free_mem_gb: 0, timing_allowed: false, services: [] };
  const git = installPlan(win, 'git');
  assert.match(git.display[0], /winget install --id Git\.Git/); assert.equal(git.steps.length, 1); assert.ok('argv' in git.steps[0] && git.steps[0].argv[0] === 'ssh');
  assert.match(installPlan({ ...win, os: 'linux' }, 'cmake').display[0], /apt-get install -y cmake ninja-build/);
  assert.throws(() => installPlan({ ...win, os: 'linux' }, 'unreal'), InstallRefused);
  assert.throws(() => installPlan({ ...win, connect: { local: true } }, 'unreal'), InstallRefused);
  assert.throws(() => installPlan(win, 'rm -rf'), InstallRefused);
  assert.equal(unrealDest([{ mount: 'C:', free_gb: 40 }, { mount: 'D:', free_gb: 300 }], '5.8', 30), path.win32.join('D:', path.win32.sep, 'Epic Games', 'UE_5.8'));
  assert.equal(unrealDest([{ mount: 'C:', free_gb: 40 }], '5.8', 30), undefined);
  const bare = suggestRoles('windows', { at: 'now', gpus: [], tools: {}, threads: 16, ram_gb: 32 }, { custom: { tools: ['compiler', 'cmake', 'python'] } });
  assert.deepEqual([...new Set(bare.missing.map(m => m.item))].sort(), ['cmake', 'compiler', 'python']);
});

test('independent locks run together, same-lock work is refused, and spawn failures are recorded', async () => {
  const p = project();
  let copyId = '';
  const slow = (lock: string) => plan([{ label: lock, argv: node('setTimeout(() => console.log("finished"), 150)') }], { lock });
  const copy = finished(p, end => { copyId = startJob(p, slow('copy-engine'), { onEnd: end }).id; });
  const install = finished(p, end => startJob(p, slow('install'), { onEnd: end }));
  assert.equal(machineJobs(p).filter(j => j.status === 'running').length, 2);
  assert.throws(() => startJob(p, slow('install')), InstallRefused);
  assert.throws(() => startJob(p, slow('copy-engine')), InstallRefused);
  assert.ok(machineJobs(p).some(j => j.id === copyId));
  assert.deepEqual((await Promise.all([copy, install])).map(j => j.status), ['ok', 'ok']);
  const failed = await finished(p, end => startJob(p, slow('install'), { spawn: () => { throw new Error('Could not start the program'); }, onEnd: end }));
  assert.equal(failed.status, 'failed');
  assert.match(failed.output, /Could not start/);
});
