import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './api-fixture.ts';
import { startJob, type MachineJob } from '../src/machines/jobs.ts';
import { machinesView } from '../src/machines/probe.ts';
import { validateMachines } from '../src/machines/config.ts';
import { writeStateFile } from '../src/orders/state-files.ts';

test('installation API previews commands, gates engine items, lists all running jobs and cancels only its own job', async () => {
  const f = await fixture({ populate: false, signIn: true, project: dir => {
    const file = path.join(dir, 'machines.yaml');
    writeFileSync(file, 'machines:\n  - { id: box, name: Box, os: windows, connect: { local: true } }\n');
    return { machines: file };
  } });
  const project = f.board.ctx.projects[0];
  const preview = await f.get('/api/machines/install-plan?id=box&item=git');
  assert.equal(preview.status, 200);
  assert.match(preview.body.plan.display[0], /winget install/);
  assert.equal(preview.body.plan.steps.every((step: unknown) => typeof step === 'string'), true);
  assert.equal((await f.get('/api/machines/jobs')).body.jobs.length, 0, 'preview starts no job');
  assert.equal((await f.get('/api/machines/install-plan?id=box&item=unreal')).status, 409);
  assert.equal((await f.get('/api/machines/install-plan?id=missing&item=git')).status, 409);
  assert.equal((await f.post('/api/machines/install', { id: 'box', item: 'git' })).status, 401);   // a write needs the key
  assert.equal((await f.write('/api/machines/install', { id: 'box', item: 'unknown' })).status, 409);

  // Exercise the real job runner with a harmless local Node process, never a package manager.
  let running!: MachineJob;
  const ended = new Promise<MachineJob>(resolve => {
    running = startJob(project, { machine: 'box', item: 'test', title: 'Test process', estimate: '', notes: [], display: ['node test'], steps: [{ label: 'Wait', argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] }] }, { onEnd: resolve });
  });
  try {
    const jobs = await f.get('/api/machines/jobs?id=box');
    assert.equal(jobs.body.jobs[0].id, running.id);
    assert.equal((await f.post('/api/machines/jobs/cancel', { job: running.id })).status, 401);
    assert.equal((await f.write('/api/machines/jobs/cancel', { job: running.id })).body.job.status, 'cancelled');
    assert.equal((await ended).status, 'cancelled');
  } finally {
    if (running.status === 'running') await f.write('/api/machines/jobs/cancel', { job: running.id });
  }
  const config = validateMachines({ machines: [{ id: 'box', name: 'Box', os: 'windows', connect: { local: true } }] });
  const history = Array.from({ length: 9 }, (_, i) => ({ ...running, id: `stored-${i}`, status: i === 8 ? 'running' : 'ok', started: new Date(Date.now() - i * 1000).toISOString(), runner_pid: process.pid }));
  writeStateFile(project, '_machine-jobs.json', JSON.stringify(history));
  const view = machinesView(project, config)[0];
  assert.ok(view.jobs.some(j => j.id === 'stored-8'), 'a running job stays visible beyond the five recent entries');
});
