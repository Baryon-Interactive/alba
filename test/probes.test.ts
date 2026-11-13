import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Probes } from '../src/tick/gather.ts';
import { cachedProbes } from '../src/web/snapshot.ts';
const fakeProbes = (): Probes => ({} as unknown as Probes);

test('slow probes: an old answer is still given while a fresh one is read in the background', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let asyncCalls = 0;
  const base: Probes = {
    ...fakeProbes(),
    now: () => new Date(clock),
    runCommand: () => { calls++; return `sync-${calls}`; },
    runCommandAsync: async () => { asyncCalls++; return `async-${asyncCalls}`; },
    freeRamGb: () => 10,
    freeRamGbAsync: async () => 20,
  };
  const slow = cachedProbes(base, 60_000);
  assert.equal(slow.runCommand(['q'], 5), 'sync-1');            // first time: nothing to give yet, so it waits
  clock += 30_000;
  assert.equal(slow.runCommand(['q'], 5), 'sync-1');            // fresh enough
  clock += 40_000;                                                // now 70 s old
  assert.equal(slow.runCommand(['q'], 5), 'sync-1');            // stale answer, given at once
  assert.equal(slow.runCommand(['q'], 5), 'sync-1');            // still one refresh at a time
  await new Promise(r => setImmediate(r));
  assert.equal(asyncCalls, 1);
  assert.equal(calls, 1);                                         // the blocking read was not used again
  assert.equal(slow.runCommand(['q'], 5), 'async-1');           // the refreshed answer
  assert.equal(slow.freeRamGb(), 10);
  clock += 70_000;
  assert.equal(slow.freeRamGb(), 10);
  await new Promise(r => setImmediate(r));
  assert.equal(slow.freeRamGb(), 20);
});

test('slow probes without a non-blocking form refresh in place', () => {
  let clock = 0;
  let calls = 0;
  const base: Probes = { ...fakeProbes(), now: () => new Date(clock), runCommand: () => `v${++calls}` };
  const slow = cachedProbes(base, 1000);
  assert.equal(slow.runCommand(['q'], 5), 'v1');
  clock += 2000;
  assert.equal(slow.runCommand(['q'], 5), 'v2');
});

test('slow probes: git activity of a worktree is kept and refreshed in the background too', async () => {
  let clock = 0;
  let asyncCalls = 0;
  const base: Probes = { ...fakeProbes(), now: () => new Date(clock), gitActivity: () => ({ dirtyFiles: 1 }), gitActivityAsync: async () => ({ dirtyFiles: ++asyncCalls + 1 }) };
  const slow = cachedProbes(base, 60_000);
  assert.deepEqual(slow.gitActivity('/wt/a'), { dirtyFiles: 1 });
  assert.deepEqual(slow.gitActivity('/wt/b'), { dirtyFiles: 1 });
  clock += 61_000;
  assert.deepEqual(slow.gitActivity('/wt/a'), { dirtyFiles: 1 });          // stale, at once
  await new Promise(r => setImmediate(r));
  assert.deepEqual(slow.gitActivity('/wt/a'), { dirtyFiles: 2 });          // refreshed
  assert.equal(asyncCalls, 1);
});

test('endpoint probes never block a page, cache failures per worker and refresh after TTL', async () => {
  let clock = 0;
  const pending: ((value: boolean) => void)[] = [];
  const base: Probes = {
    ...fakeProbes(), now: () => new Date(clock),
    probePort: () => new Promise(resolve => pending.push(resolve)),
  };
  const slow = cachedProbes(base, 1000);
  const read = (worker = 'a', port = 9) => slow.endpointAvailable!(worker, '127.0.0.1', port, 3000);
  assert.equal(read(), false);
  assert.equal(read(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 1, 'a pending probe is shared');
  pending.shift()!(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read(), false);
  assert.equal(pending.length, 0, 'failed probes have a TTL too');
  clock += 1001;
  assert.equal(read(), false);
  await new Promise(resolve => setImmediate(resolve));
  pending.shift()!(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read(), true);
  assert.equal(read('b'), false, 'another worker has its own answer');
  assert.equal(read('a', 10), false, 'a changed endpoint cannot reuse an old answer');
  await new Promise(resolve => setImmediate(resolve));
  for (const resolve of pending.splice(0)) resolve(false);
  clock += 1001;
  assert.equal(read(), true, 'stale answers return immediately during a refresh');
  await new Promise(resolve => setImmediate(resolve));
  pending.shift()!(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read(), false);
});
