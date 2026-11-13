import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { producerLog } from '../src/producer/activity.ts';
import { producerSession, type SessionEngine } from '../src/producer/session.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { Orders } from '../src/orders/service.ts';
import type { Probes } from '../src/tick/gather.ts';
import { startServe, type Serve } from '../src/serve/serve.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { loadProject, testStore } from './state-helper.ts';

const started: Serve[] = [];
after(() => { for (const serve of started) serve.stop(); });

test('a wanted session restarts after serve, a person stop stays stopped, and a failed start backs off', async () => {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  mkdirSync(path.join(dir, 'game'), { recursive: true });
  const file = path.join(dir, 'factory.yaml');
  writeFileSync(file, 'id: demo\nname: Demo\nroot: game\nwork_orders: orders\nstate_dir: state\n');
  const project = loadProject(file);
  project.producer.enabled = true;
  project.producer.session.enabled = true;
  project.producer.session.cli = process.execPath;
  const orders = new Orders(testStore(project.state_dir));
  const recent = new Date(Date.now() - 60_000).toISOString();
  writeStateFile(project, '_producer-session.json', JSON.stringify({ state: 'stopped', wanted: true, turns: 0, lastHeartbeat: recent, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
  let fail = false, starts = 0, generation = 0;
  const engine: SessionEngine = {
    async start() { starts++; if (fail) throw new Error('engine unavailable'); },
    async sendBatch() {},
    async *readEvents() { const mine = generation; while (mine === generation) await new Promise(resolve => setTimeout(resolve, 20)); },
    async stop() { generation++; },
    usage: () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
  };
  const probes = { now: () => new Date(), isAlive: () => false, tail: () => '', head: () => '', readText: () => undefined, fileTime: () => undefined, runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), spawnDetached: () => { throw new Error('No model may start'); } } as unknown as Probes;
  const manager = producerSession(project, orders, () => engine, probes);
  const serve = startServe({ projects: [project], workers: validateWorkers({ workers: [{ id: 'fixture', engine: 'x', enabled: false }] }, 'w.yaml'), port: 0, probes, everyMinutes: 0, maxDispatch: 0, print: () => {}, reloadConfigs: false });
  started.push(serve);
  for (let i = 0; i < 50 && manager.status().state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 1);
  assert.equal(manager.status().wanted, true);
  assert.equal(manager.status().state, 'running');
  assert.ok(manager.status().lastRestartedAt);
  const restarted = () => testStore(project.state_dir).events().filter(event => event.type === 'producer.session-restarted');
  assert.deepEqual(restarted().map(event => event.data?.reason), ['not-running']);
  const now = producerLog(project, orders).now;
  assert.equal(now.wanted, true);
  assert.equal(now.lastRestartedAt, manager.status().lastRestartedAt);
  await manager.maintainWanted({ startup: true, now: new Date() });
  assert.equal(starts, 1);

  await manager.stop();
  const aged = { ...manager.status(), lastHeartbeat: new Date(Date.now() - 11 * 60_000).toISOString() };
  writeStateFile(project, '_producer-session.json', JSON.stringify(aged));
  const stale = await manager.maintainWanted({ startup: false, now: new Date() });
  assert.equal(stale.state, 'running');
  assert.equal(starts, 2);
  assert.deepEqual(restarted().map(event => event.data?.reason), ['not-running', 'stale-heartbeat']);

  const stopped = await serve.sessionControl(project.id, 'stop');
  assert.equal(stopped.wanted, false);
  assert.equal(stopped.state, 'stopped');
  await manager.maintainWanted({ startup: true, now: new Date() });
  await manager.onPass([{ id: 'question', key: 'question/DEMO', project: project.id, trigger: 'question', status: 'open', revision: 1, openedAt: recent, updatedAt: recent, facts: {}, card: { trigger: 'question', summary: 'Choose a layout', pointers: [], untrusted: [] } }]);
  assert.equal(starts, 2);
  assert.equal(manager.status().wanted, false);
  assert.equal(manager.status().state, 'stopped');

  fail = true;
  writeStateFile(project, '_producer-session.json', JSON.stringify({ ...manager.status(), state: 'stopped', wanted: true, restartBackoffUntil: undefined, restartFailures: 0, lastError: undefined, errorAt: undefined, retryAt: undefined }));
  const failed = await manager.maintainWanted({ startup: true, now: new Date() });
  assert.equal(failed.state, 'error');
  assert.equal(starts, 3);
  assert.equal(Date.parse(failed.restartBackoffUntil!) - Date.parse(failed.errorAt!), 60_000);
  assert.equal(restarted().length, 3);
  const held = await manager.maintainWanted({ startup: true, now: new Date() });
  assert.equal(held.state, 'error');
  assert.equal(starts, 3);
  assert.equal(restarted().length, 3);
  await manager.stop();
  serve.stop();
});
