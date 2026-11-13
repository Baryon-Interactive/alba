import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { PRODUCER_ACTIONS, loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { readStateFile, writeStateFile } from '../src/orders/state-files.ts';
import { runProducerMcp } from '../src/producer/mcp.ts';
import { producerAct, producerActions, producerAudit, type ProducerCase } from '../src/producer/producer.ts';
import { PRODUCER_READ_KINDS } from '../src/producer/tool-schemas.ts';

function fixture(backend: 'files' | 'sqlite' = 'files') {
  const parent = path.resolve('.state/producer-mcp-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'fixture-'));
  mkdirSync(path.join(root, 'orders'));
  const file = path.join(root, 'alba.yaml');
  writeFileSync(file, stringify({
    id: 'demo', name: 'Demo', root, work_orders: path.join(root, 'orders'), state_dir: path.join(root, 'state'), state: { backend },
    producer: { enabled: true, rules: [], session: { enabled: false } },
  }));
  const project = loadProject(file);
  const orders = new Orders(stateStore(project));
  const card: ProducerCase = { id: 'case-1', key: 'question/DEMO', project: project.id, trigger: 'question', status: 'open', revision: 1, openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', order: 'DEMO', facts: {}, card: { trigger: 'question', summary: 'Fixture question', pointers: [], untrusted: ['summary'] } };
  writeStateFile(project, '_producer-cases.json', JSON.stringify([card]));
  return { project, orders };
}

async function requests(file: string, messages: object[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const done = runProducerMcp(file, input, output);
  input.end(messages.map((message, id) => JSON.stringify({ jsonrpc: '2.0', id, ...message })).join('\n') + '\n');
  await done;
  return Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
}
const call = (name: string, args: unknown) => ({ method: 'tools/call', params: { name, arguments: args } });

test('producer MCP lists complete schemas with the validated action and read kind enums', async () => {
  const { project } = fixture();
  const [reply] = await requests(project.file, [{ method: 'tools/list' }]);
  const tools = reply.result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['producer_direction_propose', 'producer_read', 'producer_act', 'producer_notes', 'producer_review', 'producer_draft', 'producer_work']);
  const act = tools.find((tool: { name: string }) => tool.name === 'producer_act').inputSchema;
  const action = act.properties.actions.items;
  assert.deepEqual(action.properties.kind.enum, PRODUCER_ACTIONS);
  assert.deepEqual(action.required, ['case', 'kind']);
  assert.equal(action.properties.case.type, 'string');
  assert.equal(action.properties.evidence.maxItems, 20);
  assert.equal(action.properties.evidence.items.type, 'string');
  assert.equal(act.properties.actions.minItems, 1);
  assert.equal(act.properties.actions.maxItems, 20);
  const read = tools.find((tool: { name: string }) => tool.name === 'producer_read').inputSchema;
  assert.deepEqual(read.properties.kind.enum, PRODUCER_READ_KINDS);
  assert.equal(read.properties.page.minimum, 0);
  assert.match(read.properties.page.description, /Zero-based/);
  const described = (schema: any) => {
    assert.equal(typeof schema.description, 'string');
    assert.ok(schema.description.length > 0);
    for (const field of Object.values(schema.properties ?? {})) described(field);
    if (schema.items) described(schema.items);
  };
  for (const tool of tools) { assert.ok(tool.description); described(tool.inputSchema); }
  // Model APIs reject top-level combinators and Claude Code drops such tools silently.
  for (const tool of tools) for (const key of ['anyOf', 'oneOf', 'allOf']) assert.equal(tool.inputSchema[key], undefined, `${tool.name} lists a top-level ${key}`);
});

test('bad action calls list kinds and required fields and leave the entire batch unrecorded', async () => {
  const { project, orders } = fixture();
  const valid = { case: 'case-1', kind: 'note', note: 'Should never be recorded' };
  const invalid = [
    { actions: [{ ...valid, kind: 'add-order' }] },
    { caseId: 'case-1', kind: 'note' },
    { actions: [valid, { case: 'case-1', kind: 'requeue' }] },
    { actions: [valid, { case: 'case-1', action: 'note' }] },
    { actions: [{ kind: 'note' }] },
    { actions: [{ case: ' ', kind: 'note' }] },
    { actions: [{ ...valid, evidence: ['proof', 1] }] },
    { actions: [{ ...valid, evidence: Array(21).fill('proof') }] },
    { actions: [{ ...valid, note: 3 }] },
    { actions: [null] },
    { actions: [] },
    { actions: Array(21).fill(valid) },
    {},
  ];
  const before = { actions: producerActions(project), audit: producerAudit(project), wouldDo: readStateFile(project, 'producer-would-do.jsonl') };
  for (const reply of await requests(project.file, invalid.map(args => call('producer_act', args)))) {
    assert.equal(reply.result, undefined);
    assert.match(reply.error.message, /Required fields: actions.*case, kind/);
    for (const kind of PRODUCER_ACTIONS) assert.ok(reply.error.message.includes(kind));
  }
  assert.throws(() => producerAct(project, orders, 'case-1', 'requeue'), /Valid kinds:.*Required fields:/);
  assert.throws(() => producerAct(project, orders, '', 'note'), /Valid kinds:.*Required fields:/);
  assert.deepEqual(producerActions(project), before.actions);
  assert.deepEqual(producerAudit(project), before.audit);
  assert.equal(readStateFile(project, 'producer-would-do.jsonl'), before.wouldDo);
  const [validReply] = await requests(project.file, [call('producer_act', { actions: [{ ...valid, evidence: ['proof.md'] }] })]);
  const [recorded] = JSON.parse(validReply.result.content[0].text);
  assert.equal(recorded.kind, 'note');
  assert.deepEqual(recorded.evidence, ['proof.md']);
  assert.equal(producerActions(project).length, 1);
});

test('bad read calls list all kinds and explain the required order tag', async () => {
  const { project } = fixture();
  const replies = await requests(project.file, [{ kind: 'unknown' }, {}, { kind: 'order' }, { kind: 'order', tag: ' ' }, { kind: 'cases', page: -1 }, { kind: 'cases', page: 0.5 }].map(args => call('producer_read', args)));
  for (const reply of replies) {
    assert.match(reply.error.message, /Required fields: kind; tag/);
    for (const kind of PRODUCER_READ_KINDS) assert.ok(reply.error.message.includes(kind));
  }
});

for (const backend of ['files', 'sqlite'] as const) test(`order read returns delivery context and recent human actions without changing state (${backend})`, async () => {
  const { project, orders } = fixture(backend);
  orders.add({ tag: 'BASE', title: 'Dependency', kind: 'code' });
  orders.add({ tag: 'DEMO', title: 'Fixture delivery', kind: 'code', needs: ['BASE'] });
  orders.report('DEMO', { status: 'failed', summary: 'Old report', evidence: [], commits: [] });
  orders.report('DEMO', { status: 'ready', summary: 'Latest delivery', evidence: ['proof.txt'], commits: ['abc1234'] });
  for (const [index, kind] of (['queue', 'hold', 'release', 'rework', 'approve', 'cancel'] as const).entries()) orders.act('DEMO', kind, { force: true, note: `Human note ${index}` });
  orders.record('DEMO', 'order-verified', { results: [{ name: 'old', status: 'fail', reason: 'Superseded result' }] });
  const verify = [{ name: 'paths', status: 'pass', reason: 'Allowed changes only' }, { name: 'check', status: 'warn', reason: 'Manual review required' }];
  orders.record('DEMO', 'order-verified', { results: verify });
  orders.record('DEMO', 'unrelated-event');
  const sections = '## Acceptance\n- Check the fixture.\n### Detail\nKeep this subsection.\n\n## Evidence\n- proof.txt\n\n## Paths\n- allow: src/**\n';
  writeFileSync(path.join(project.work_orders, 'DEMO-delivery.md'), `# Delivery\n${'Context🙂'.repeat(6000)}\n${sections}`);
  const events = orders.store.events();
  const doc = orders.get('DEMO');
  const [reply] = await requests(project.file, [call('producer_read', { kind: 'order', tag: 'demo', page: 99 })]);
  const detail = JSON.parse(reply.result.content[0].text);
  assert.equal(detail.tag, 'DEMO');
  assert.equal(detail.title, 'Fixture delivery');
  assert.equal(detail.stage, 'cancelled');
  assert.equal(detail.kind, 'code');
  assert.deepEqual(detail.needs, ['BASE']);
  assert.ok(Buffer.byteLength(detail.body) <= 12 * 1024);
  assert.ok(detail.body.includes(sections));
  assert.ok(!detail.body.includes('\uFFFD'));
  assert.deepEqual(detail.report, { status: 'ready', summary: 'Latest delivery', evidence: ['proof.txt'], commits: ['abc1234'] });
  assert.deepEqual(detail.verify, verify);
  assert.equal(detail.actions.length, 5);
  assert.deepEqual(detail.actions.map((action: { kind: string; note: string }) => [action.kind, action.note]), [['cancel', 'Human note 5'], ['approve', 'Human note 4'], ['rework', 'Human note 3'], ['release', 'Human note 2'], ['hold', 'Human note 1']]);
  assert.deepEqual(orders.store.events(), events);
  assert.deepEqual(orders.get('DEMO'), doc);
  assert.deepEqual(producerActions(project), []);
});

test('order read preserves short text exactly and handles absent delivery facts and oversized critical sections', async () => {
  const { project, orders } = fixture();
  orders.add({ tag: 'DEMO', title: 'Draft', kind: 'code' });
  const file = path.join(project.work_orders, 'DEMO.md');
  const read = async () => {
    const [reply] = await requests(project.file, [call('producer_read', { kind: 'order', tag: 'DEMO' })]);
    return JSON.parse(reply.result.content[0].text);
  };
  writeFileSync(file, '# Draft\n\nNo delivery yet.\n');
  const detail = await read();
  assert.equal(detail.body, '# Draft\n\nNo delivery yet.\n');
  assert.equal(detail.report, null);
  assert.deepEqual(detail.verify, []);
  assert.deepEqual(detail.actions, []);
  writeFileSync(file, ['# Draft', '## Acceptance', 'a'.repeat(20000), '## Evidence', 'b'.repeat(20000), '## Paths', 'c'.repeat(20000)].join('\n'));
  const oversized = await read();
  assert.ok(Buffer.byteLength(oversized.body) <= 12 * 1024);
  for (const heading of ['Acceptance', 'Evidence', 'Paths']) assert.ok(oversized.body.includes(`## ${heading}\n`));
  const sections = '\nAcceptance\n----------\n- All checks pass.\n\n## **Evidence** ##\n```md\n## Example heading inside code\n```\n- proof.txt\n\n## Paths\n- allow: src/**\n';
  writeFileSync(file, '# Draft\n' + 'x'.repeat(20000) + '\n' + sections);
  const markdown = await read();
  assert.ok(markdown.body.includes(sections.trimStart()));
  assert.ok(Buffer.byteLength(markdown.body) <= 12 * 1024);
});
