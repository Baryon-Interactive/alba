import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject } from '../src/config.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { callProducerTool } from '../src/producer/mcp.ts';
import { producerSnapshot, snapshotFactIds } from '../src/producer/conversation-state.ts';
import { readProducerStatus } from '../src/producer/status-read.ts';
import { computeFacts } from '../src/producer/facts/engine.ts';
import { FACTS_META } from '../src/producer/facts/snapshot.ts';
import { producerReadFixture, ago, NOW } from './fixtures/producer-reads.ts';

function read(f: ReturnType<typeof producerReadFixture>, args: Record<string, unknown>): any {
  return callProducerTool(f.project, f.orders, 'producer_read', args);
}
for (const backend of ['files', 'sqlite'] as const) {
  test(`compact status uses tick stalls, capacities, held age, timestamps and modes (${backend})`, () => {
    const f = producerReadFixture(backend), before = f.orders.store.events();
    const { text } = readProducerStatus(f.project, f.orders, {}, f);
    assert.ok(text.length <= 6000, `${text.length} characters`);
    assert.match(text, /Stalled runs \(tick rule\) \(1\)/);
    assert.match(text, /SLOW: no commit for 2 h/);
    assert.match(text, /SLOW code worker=builder commit=2026-01-10T10:00:00.000Z \(120m\) age=180m/);
    assert.match(text, /kind code 2\/3; free 1: no ready order/);
    assert.match(text, /kind art 0\/1; free 1: needs: NEEDS/);
    assert.match(text, /resource build 1\/1/);
    assert.match(text, /memory 12.0 GB free \/ minimum 4 GB/);
    assert.match(text, /HOLD held 4 days/);
    assert.match(text, /commit-reminder \(1\): stall\/SLOW/);
    assert.match(text, /remind: auto \(nudge\)/);
    assert.doesNotMatch(text, /CLOSED|failed\/RETRY/);
    assert.deepEqual(f.orders.store.events(), before);
    writeFileSync(path.join(f.project.root, 'status.txt'), `${text}\n\nCharacter count: ${text.length}\n`);
  });
}

test('status follows the tick exception for recent logs', () => {
  const f = producerReadFixture();
  f.probes.fileTime = file => file.endsWith('run.log') ? ago(5) : undefined;
  f.orders.patchRun('SLOW', 'r1', { log: path.join(f.project.root, 'run.log') });
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /Stalled runs \(tick rule\) \(0\)/);
});

test('status explains lease, memory, quota and dispatchable slots', () => {
  const f = producerReadFixture();
  f.setTime(0);
  f.orders.add({ tag: 'NEXT', title: 'Next build', kind: 'code', uses: ['build'] });
  f.orders.act('NEXT', 'queue');
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /resource build is full/);
  f.probes.freeRamGb = () => 1;
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /free memory 1.0 GB is below 4 GB/);
  f.probes.freeRamGb = () => 12;
  f.workers.workers[0].enabled = false;
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /nobody can take it.*turned off/);
  f.workers.workers[0].enabled = true;
  f.workers.workers[0].quota = 'fixture';
  f.workers.workers[0].disabled_when = [{ window_full: '*', at: 100 }];
  f.workers.quota_sources.fixture = { type: 'static', unlimited: false, windows: [{ name: 'daily', used_percent: 100 }] };
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /nobody can take it.*100%/);
  f.workers.quota_sources.fixture = { type: 'static', unlimited: true, windows: [] };
  f.orders.update('NEXT', { uses: [] });
  assert.match(readProducerStatus(f.project, f.orders, {}, f).text, /next tick: NEXT/);
});

test('collections filter tags, stages, since and triggers, sort newest first and hide stale cases', () => {
  const f = producerReadFixture();
  const parse = (args: Record<string, unknown>) => JSON.parse(read(f, args).text);
  assert.deepEqual(parse({ kind: 'orders' }).map((r: any) => r.order.tag), ['RETRY', 'SLOW', 'BASE', 'HOLD', 'NEEDS']);
  assert.deepEqual(parse({ kind: 'orders', tag: ['slow', 'retry'], stage: 'running', since: ago(30) }).map((r: any) => r.order.tag), ['RETRY']);
  assert.ok(parse({ kind: 'orders', include_closed: true }).some((r: any) => r.order.tag === 'CLOSED'));
  assert.equal(parse({ kind: 'orders', stage: 'merged' }).length, 0);
  assert.equal(parse({ kind: 'orders', stage: 'merged', include_closed: true }).length, 1);
  assert.deepEqual(parse({ kind: 'cases' }).map((c: any) => c.key), ['stall/SLOW']);
  const { order, ...projectCase } = f.cases[0];
  writeStateFile(f.project, '_producer-cases.json', JSON.stringify([...f.cases, { ...projectCase, id: 'project-closed', key: 'project-closed', status: 'closed' }]));
  assert.deepEqual(parse({ kind: 'cases' }).map((c: any) => c.key), ['stall/SLOW']);
  assert.ok(parse({ kind: 'cases', include_closed: true }).some((c: any) => c.key === 'project-closed'));
  assert.equal(parse({ kind: 'cases', trigger: 'delivery' }).length, 0);
  assert.equal(parse({ kind: 'cases', trigger: 'delivery', include_closed: true }).length, 1);
  assert.equal(parse({ kind: 'cases', since: ago(5) }).length, 0);
  assert.equal(parse({ kind: 'cases', tag: 'slow', stage: 'running' }).length, 1);
  assert.equal(parse({ kind: 'runs', tag: 'retry', since: ago(30) }).length, 2);
  assert.deepEqual(parse({ kind: 'runs', tag: 'retry' }).map((r: any) => r.run.id), ['r2', 'r1']);
  assert.equal(parse({ kind: 'runs', tag: 'slow', since: ago(30) }).length, 0);
  f.orders.report('RETRY', { status: 'failed', summary: 'Current failure', evidence: [], commits: [] });
  assert.deepEqual(parse({ kind: 'reports', stage: 'failed', tag: ['retry'], since: ago(30) }).map((r: any) => r.report.summary), ['Current failure']);
  for (const args of [{ kind: 'orders', since: 'yesterday' }, { kind: 'orders', tag: [] }, { kind: 'order', tag: ['SLOW'] }, { kind: 'cases', trigger: 'wrong' }]) assert.throws(() => read(f, args), /Invalid producer_read/);
});

test('default and configured page sizes include total counts and reconstruct the entire collection', () => {
  const f = producerReadFixture();
  f.orders.update('SLOW', { title: 'Long title '.repeat(2000) });
  const first = read(f, { kind: 'orders' });
  assert.equal(first.text.length, 12000);
  assert.ok(first.pages >= 2);
  f.project.producer.session.page_chars = 701;
  const smaller = read(f, { kind: 'orders' });
  let source = '';
  for (let page = 0; page < smaller.pages; page++) {
    const result = read(f, { kind: 'orders', page });
    assert.equal(result.pages, smaller.pages);
    assert.ok(result.text.length <= 701);
    source += result.text;
  }
  assert.equal(JSON.parse(source).length, 5);
  assert.equal(smaller.pages, Math.ceil(source.length / 701));
  assert.equal(read(f, { kind: 'orders', page: smaller.pages }).text, '');
  assert.deepEqual(read(f, { kind: 'orders', tag: 'missing' }), { page: 0, pages: 1, text: '[]' });
  const config = f.project.file;
  const yaml = `id: demo\nname: Demo\nroot: .\nwork_orders: orders\nstate_dir: state\nproducer:\n  session:\n    page_chars: 1234\n`;
  writeFileSync(config, yaml);
  assert.equal(loadProject(config).producer.session.page_chars, 1234);
  for (const invalid of ['0', '-1', '1.5', 'false']) {
    writeFileSync(config, yaml.replace('1234', invalid));
    assert.throws(() => loadProject(config), /page_chars/);
  }
});

test('facts use the current stored snapshot, summarize values and units, and return one full fact', () => {
  const f = producerReadFixture();
  assert.equal(read(f, { kind: 'facts' }).available, false);
  const snapshot = computeFacts({ orders: f.orders.all(), events: [], usage: [], caps: f.project.dispatch.caps, now: NOW });
  f.orders.store.writeMeta(FACTS_META, snapshot);
  const summary = read(f, { kind: 'facts' });
  assert.ok(snapshotFactIds(producerSnapshot(f.project, 'facts')).includes('F:kind.code.wip.24h'));
  assert.ok(summary.text.includes('F:kind.code.wip.24h: 2 orders'));
  assert.ok(summary.text.includes('F:kind.code.held.24h: 1 orders'));
  assert.doesNotMatch(summary.text, /tags|evidence|timelines/);
  const full = snapshot.facts.find(fact => fact.id === 'F:kind.code.wip.24h');
  assert.deepEqual(read(f, { kind: 'facts', fact: full!.id }), { available: true, value: full });
  assert.deepEqual(read(f, { kind: 'facts', fact: 'missing' }), { available: false, value: null });
  assert.equal(read(f, { kind: 'facts', since: ago(-1) }).text, '');
  const filtered = read(f, { kind: 'facts', tag: 'SLOW', stage: 'running' });
  assert.ok(filtered.text.includes('F:kind.code.wip.24h'));
  assert.doesNotMatch(filtered.text, /kind.code.held/);
  const old = structuredClone(snapshot);
  old.facts = old.facts.filter(fact => !fact.id.includes('.held.'));
  for (const fact of old.facts.filter(fact => /^F:kind.code.wip\./.test(fact.id))) {
    fact.value = Number(fact.value) + 1;
    fact.tags?.push('HOLD');
  }
  f.orders.store.writeMeta(FACTS_META, old);
  assert.deepEqual(read(f, { kind: 'facts', fact: full!.id }), { available: true, value: old.facts.find(fact => fact.id === full!.id) }, 'reads preserve the stored value instead of converting an obsolete projection');
  assert.deepEqual(f.orders.store.readMeta(FACTS_META), old);
});

test('status remains below 6000 characters with 200 orders and explicit omission counts', () => {
  const f = producerReadFixture();
  for (let index = 0; index < 195; index++) f.orders.add({ tag: `DEMO${index}`, title: 'Large fixture', kind: 'code' });
  const result = readProducerStatus(f.project, f.orders, {}, f);
  assert.match(result.text, /200 open orders/);
  assert.ok(result.text.length <= 6000, `${result.text.length} characters`);
  assert.match(result.text, /omitted; use filtered producer_read/);
});
