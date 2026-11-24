import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, type ProjectConfig } from '../src/config.ts';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { claimIdempotency, bodyHashOf, IDEMPOTENCY_TTL_MS } from '../src/api/idempotency.ts';
import { startServer } from '../src/web/server.ts';
import type { Probes } from '../src/tick/gather.ts';

function makeProject(backend: 'sqlite' | 'files' = 'sqlite'): { dir: string; project: ProjectConfig; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-idem-'));
  const root = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  const state = path.join(dir, 'state');
  mkdirSync(root, { recursive: true });
  mkdirSync(work, { recursive: true });
  const file = path.join(dir, 'alba.yaml');
  writeFileSync(file, [
    'id: demo',
    'name: Demo',
    `root: ${root.replace(/\\/g, '/')}`,
    `work_orders: ${work.replace(/\\/g, '/')}`,
    `state_dir: ${state.replace(/\\/g, '/')}`,
    `state: { backend: ${backend} }`,
  ].join('\n') + '\n', 'utf8');
  return {
    dir,
    project: loadProject(file),
    cleanup: () => {
      closeStateStores();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeProbes(getNow: () => Date): Probes {
  return {
    now: getNow,
    runCommand: () => '',
    freeRamGb: () => 16,
    isAlive: () => false,
    worktrees: () => [],
    gitActivity: () => ({ dirtyFiles: 0 }),
    fileTime: () => undefined,
    tail: () => '',
    readText: () => undefined,
    spawnDetached: () => 0,
  };
}

async function withServer(backend: 'sqlite' | 'files', fn: (ctx: {
  base: string;
  project: ProjectConfig;
  setNow: (d: Date) => void;
  getNow: () => Date;
}) => Promise<void>) {
  const env = makeProject(backend);
  let now = new Date('2026-06-15T10:00:00.000Z');
  const server = startServer({ projects: [env.project], port: 0, probes: fakeProbes(() => now), background: false });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, project: env.project, setNow: d => { now = d; }, getNow: () => now });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    env.cleanup();
  }
}

for (const backend of ['sqlite', 'files'] as const) {
  test(`idempotency replay, mismatch, in-progress, expiry, and no-header (${backend})`, async () => {
    await withServer(backend, async ({ base, project, setNow, getNow }) => {
      const orders = new Orders(stateStore(project), () => getNow().toISOString(), 'cli');
      orders.add({ tag: 'T1', title: 'Task one', kind: 'code' });
      orders.add({ tag: 'T2', title: 'Task two', kind: 'code' });

      // 1. Replay returns stored response with Idempotent-Replay: true and applies the action only once
      const first = await fetch(`${base}/api/orders/T1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'act-queue-1' },
        body: JSON.stringify({ project: 'demo', action: 'hold', note: 'first hold' }),
      });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('idempotent-replay'), null);
      const firstBody = await first.json();

      // Replaying with canonical-equivalent JSON (different key order) replays without acting a second time
      const replay = await fetch(`${base}/api/orders/T1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'act-queue-1' },
        body: JSON.stringify({ note: 'first hold', action: 'hold', project: 'demo' }),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get('idempotent-replay'), 'true');
      const replayBody = await replay.json();
      assert.deepEqual(replayBody, firstBody);
      // Assert only a single hold action was recorded on T1
      const docT1 = new Orders(stateStore(project)).get('T1');
      assert.equal(docT1.actions.filter(a => a.kind === 'hold').length, 1);

      // 2. Same key with different body returns 409 request_mismatch and does not act
      const bodyMismatch = await fetch(`${base}/api/orders/T1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'act-queue-1' },
        body: JSON.stringify({ project: 'demo', action: 'release' }),
      });
      assert.equal(bodyMismatch.status, 409);
      const bodyMismatchJson = await bodyMismatch.json() as { error: { code: string } };
      assert.equal(bodyMismatchJson.error.code, 'request_mismatch');
      assert.equal(new Orders(stateStore(project)).stage(new Orders(stateStore(project)).get('T1')).stage, 'held');

      // 3. Same key with different route returns 409 request_mismatch and does not act
      const routeMismatch = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'act-queue-1' },
        body: JSON.stringify({ project: 'demo', action: 'hold', note: 'first hold' }),
      });
      assert.equal(routeMismatch.status, 409);
      const routeMismatchJson = await routeMismatch.json() as { error: { code: string } };
      assert.equal(routeMismatchJson.error.code, 'request_mismatch');
      assert.equal(new Orders(stateStore(project)).get('T2').actions.length, 0);

      // 4. In-progress request under the same key returns 409 request_in_progress
      const inProgBody = { project: 'demo', action: 'hold', note: 'busy' };
      const claimed = claimIdempotency(stateStore(project), {
        key: 'in-prog-1',
        method: 'POST',
        route: '/api/orders/T2/actions',
        bodyHash: bodyHashOf(inProgBody),
        now: getNow(),
      });
      assert.equal(claimed.outcome, 'claimed');

      const inProgRes = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'in-prog-1' },
        body: JSON.stringify(inProgBody),
      });
      assert.equal(inProgRes.status, 409);
      const inProgJson = await inProgRes.json() as { error: { code: string } };
      assert.equal(inProgJson.error.code, 'request_in_progress');
      assert.equal(new Orders(stateStore(project)).get('T2').actions.length, 0);

      // 5. Invalid key format is rejected with 400 bad_request
      const badKey = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'bad key!' },
        body: JSON.stringify({ project: 'demo', action: 'hold' }),
      });
      assert.equal(badKey.status, 400);
      assert.equal(new Orders(stateStore(project)).get('T2').actions.length, 0);

      // 6. Expiry after 24 hours purges old receipts on next write
      setNow(new Date(getNow().getTime() + IDEMPOTENCY_TTL_MS + 60_000));
      const afterExpiry = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'act-queue-1' },
        body: JSON.stringify({ project: 'demo', action: 'hold', note: 'reused after expiry' }),
      });
      assert.equal(afterExpiry.status, 200);
      assert.equal(afterExpiry.headers.get('idempotent-replay'), null);
      assert.equal(new Orders(stateStore(project)).get('T2').actions.filter(a => a.kind === 'hold').length, 1);

      // 7. Request without Idempotency-Key behaves as today (repeating hold on held T2 hits normal conflict)
      const noHeader1 = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'demo', action: 'release' }),
      });
      assert.equal(noHeader1.status, 200);
      const noHeader2 = await fetch(`${base}/api/orders/T2/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'demo', action: 'release' }),
      });
      assert.equal(noHeader2.status, 409);
      const noHeader2Json = await noHeader2.json() as { error: { code: string } };
      assert.equal(noHeader2Json.error.code, 'conflict');
    });
  });
}
