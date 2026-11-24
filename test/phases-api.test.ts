import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { validateWorkers } from '../src/workers/config.ts';

test('order API exposes phase progress, each plan and its run, and accepts rework targets', async () => {
  const phases = { code: [{ id: 'inspect', mode: 'read-only' }, { id: 'update', mode: 'write' }] };
  const workers = validateWorkers({ workers: [{ id: 'reader', engine: 'claude-cli', launch: { program: 'fake', args: ['{prompt_file}'] } }] }, 'workers.yaml');
  const f = await fixture({ workers, populate: false, now: () => new Date('2026-01-12T12:00:00Z'), project: () => ({ phases }) });
  const tag = 'CACHE';
  f.orders.add({ tag, kind: 'code', title: 'Cache lookup' });
  f.orders.act(tag, 'queue');
  f.orders.runStart(tag, { worker: 'reader', extra: { phase: 'inspect', next_phase: 'update', final_phase: false, model: 'small' } });
  f.orders.runEnd(tag);
  const ready = { status: 'ready' as const, summary: 'Checked', evidence: [], commits: [] };
  f.orders.report(tag, { ...ready, plan: 'Retain the cache key.' });
  const list = await f.get('/api/orders?project=demo');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items[0].phase, { id: 'update', index: 2, count: 2 });
  const detail = (await f.get('/api/orders/CACHE?project=demo')).body;
  assert.deepEqual(detail.phases[0], { id: 'inspect', mode: 'read-only', state: 'done', worker: 'reader', model: 'small',
    plan: 'Retain the cache key.', runs: [{ id: 'r1', worker: 'reader', model: 'small' }] });
  assert.equal(detail.phases[1].state, 'current');
  assert.equal(detail.reports[0].plan, detail.phases[0].plan);
  f.orders.runStart(tag, { worker: 'writer', extra: { phase: 'update', final_phase: true } });
  f.orders.runEnd(tag);
  f.orders.report(tag, ready);
  const result = await f.write('/api/orders/CACHE/actions', { project: 'demo', action: 'rework', phase: 'inspect', note: 'Recheck the key' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const restarted = (await f.get('/api/orders/CACHE?project=demo')).body;
  assert.equal(restarted.phases[0].state, 'current');
  assert.equal(restarted.phases[0].plan, undefined);
  assert.equal(restarted.phases[0].runs.length, 1);
  const disabled = await f.write('/api/orders/CACHE/fields', { project: 'demo', phases: 'none' });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.phase, undefined);
  assert.equal((await f.get('/api/orders/CACHE?project=demo')).body.order.phases, 'none');
});
