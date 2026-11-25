import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { activeConsultFileOf } from '../src/consult/config.ts';

test('order detail lists every agent working on the order now: child runs and a consult in progress', async () => {
  const f = await fixture({ populate: false });
  const tag = 'CACHE';
  f.orders.add({ tag, title: 'Cache storage', kind: 'feature' });
  f.orders.runStart(tag, { worker: 'reader', extra: { phase: 'divide', next_phase: 'assemble', split_kinds: ['task'] } });
  f.orders.runEnd(tag);
  const subtasks = ['read', 'write'].map(key => ({ key, title: key, kind: 'task', body: '## Acceptance\n- Check the sample value.' }));
  f.orders.report(tag, { status: 'ready', summary: 'Divide cache storage', subtasks, evidence: [], commits: [] });
  const detail = async (t = tag) => (await f.get(`/api/orders/${t}?project=demo`)).body;
  const accepted = await f.write('/api/orders/CACHE/actions', { project: 'demo', action: 'accept-split', report: (await detail()).split.report });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await detail()).agents, undefined, 'no agent before the children start');

  const one = f.orders.runStart('CACHE.1', { worker: 'reader', extra: { phase: 'implement', model: 'model-a' } }).run;
  f.orders.runStart('CACHE.2', { worker: 'writer', extra: { phase: 'implement', model: 'model-b' } });
  const stateDir = path.join(f.dir, 'state');
  const marker = activeConsultFileOf(stateDir, 'CACHE.1', one.id);
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), question: 'Is the index stable?', consultant: 'advisor', model: 'model-c', timeout_minutes: 10 }));

  const parent = await detail();
  assert.deepEqual(parent.agents.map((a: { kind: string; tag: string }) => `${a.kind}:${a.tag}`), ['child:CACHE.1', 'consult:CACHE.1', 'child:CACHE.2']);
  const consult = parent.agents.find((a: { kind: string }) => a.kind === 'consult');
  assert.equal(consult.worker, 'advisor');
  assert.equal(consult.run, one.id, 'a consult links to the run that asked');
  assert.equal(consult.question, 'Is the index stable?');
  assert.equal((await detail('CACHE.1')).agents.length, 2, 'the child sees its own run and its consult');
  const list = (await f.get('/api/orders?project=demo')).body.items;
  assert.equal(list.find((o: { tag: string }) => o.tag === tag).agentsRunning, 3);

  writeFileSync(marker, JSON.stringify({ at: new Date(Date.now() - 60 * 60_000).toISOString(), question: 'old', consultant: 'advisor', model: 'model-c', timeout_minutes: 10 }));
  assert.equal((await detail()).agents.length, 2, 'a marker older than its timeout is a leftover and is ignored');
  rmSync(marker);
  f.orders.runEnd('CACHE.1');
  f.orders.runEnd('CACHE.2');
  assert.equal((await detail()).agents, undefined);

  // A child that handed a long job to the monitor still has an agent working, without an open run.
  f.orders.report('CACHE.1', { status: 'monitoring', summary: 'League running', evidence: [], commits: [], monitor: { check: ['fake-status'], done_when: { exit_code: 0 }, deadline_minutes: 60 } });
  const monitoring = await detail();
  assert.deepEqual(monitoring.agents.map((a: { kind: string; tag: string }) => `${a.kind}:${a.tag}`), ['monitor:CACHE.1']);
  assert.equal((await f.get('/api/orders?project=demo')).body.items.find((o: { tag: string }) => o.tag === tag).agentsRunning, 1);
});
