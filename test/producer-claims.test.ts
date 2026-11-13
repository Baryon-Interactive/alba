import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { producerActions, producerAudit, producerPolicy, rejectProducerAction, runProducerAction, runProducerActions, type ProducerAction, type ProducerCase } from '../src/producer/producer.ts';

/** A project whose producer runs `note` by itself, with one open case and one stored auto action that has not run yet. */
function fixture() {
  const { dir, orders } = tempOrders();
  mkdirSync(path.join(dir, 'orders'));
  const raw = {
    id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    producer: { enabled: true, rules: [{ id: 'auto-note', instruction: 'record', action: 'note', mode: 'auto' }], session: { enabled: false } },
  };
  const file = path.join(dir, 'alba.yaml');
  const project = validateProject(raw, file);
  const card: ProducerCase = { id: 'case-1', key: 'question/X', project: 'demo', trigger: 'question', status: 'open', revision: 1, openedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', facts: {}, card: { trigger: 'question', summary: 'x', pointers: [], untrusted: [] } };
  writeStateFile(project, '_producer-cases.json', JSON.stringify([card]));
  const policy = producerPolicy(project);
  const action = (id: string, extra: Partial<ProducerAction> = {}): ProducerAction => ({ id, idempotencyKey: `key-${id}`, caseId: 'case-1', caseRevision: 1, kind: 'note', status: 'proposed', note: `note ${id}`, ruleId: 'auto-note', mode: 'auto', policyVersion: policy.version, policyHash: policy.hash, at: '2026-01-01T00:00:00.000Z', ...extra });
  return { dir, orders, project, raw, file, action };
}
const stored = (project: ReturnType<typeof fixture>['project'], id: string) => producerActions(project).find(a => a.id === id)!;
const ran = (project: ReturnType<typeof fixture>['project'], id: string) => producerAudit(project).map(l => JSON.parse(l)).filter(e => e.kind === 'action' && e.id === id && e.status === 'done').length;

test('an auto action that four processes see at once runs in one of them', async () => {
  const f = fixture();
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([f.action('a1'), f.action('a2')]));
  const repo = pathToFileURL(path.resolve('.') + path.sep).href;
  const child = path.join(f.dir, 'child.mjs');
  const go = path.join(f.dir, 'go');
  writeFileSync(child, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    'const [repo, raw, file, go, ready] = process.argv.slice(2);',
    "const { validateProject } = await import(new URL('test/state-helper.ts', repo).href);",
    "const { runProducerActions } = await import(new URL('src/producer/producer.ts', repo).href);",
    "const { Orders } = await import(new URL('src/orders/service.ts', repo).href);",
    "const { stateStore } = await import(new URL('src/orders/backend.ts', repo).href);",
    'const project = validateProject(JSON.parse(raw), file);',
    'const orders = new Orders(stateStore(project));',
    "writeFileSync(ready, 'ready');",
    'while (!existsSync(go)) await new Promise(r => setTimeout(r, 2));',
    'runProducerActions(project, orders);',
  ].join('\n') + '\n');
  const readyDir = path.join(f.dir, 'ready');
  mkdirSync(readyDir);
  const exits = Array.from({ length: 4 }, (_, i) => new Promise<number>((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, repo, JSON.stringify(f.raw), f.file, go, path.join(readyDir, String(i))], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve(code) : reject(new Error(`child ${i} exited ${code}: ${err}`))));
  }));
  const deadline = Date.now() + 60000;
  while (readdirSync(readyDir).length < 4 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  writeFileSync(go, 'go');
  await Promise.all(exits);
  for (const id of ['a1', 'a2']) {
    assert.equal(ran(f.project, id), 1, `${id} ran once`);
    assert.equal(stored(f.project, id).status, 'done');
    assert.equal(stored(f.project, id).claim, undefined, 'the claim is given back');
  }
  assert.ok(existsSync(go));
});

test('an action another live process holds is not run, decided or rejected here; one held by a process that is gone is failed, not run', () => {
  const f = fixture();
  const held = { pid: process.ppid, at: new Date().toISOString() };
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([f.action('auto', { claim: held }), f.action('click', { mode: 'propose', claim: held })]));
  runProducerActions(f.project, f.orders);
  assert.deepEqual([stored(f.project, 'auto').status, stored(f.project, 'auto').claim], ['proposed', held]);
  assert.equal(runProducerAction(f.project, f.orders, 'click').status, 'proposed', 'a second click runs nothing');
  assert.equal(rejectProducerAction(f.project, 'click', 'no').status, 'proposed', 'it is not rejected under the process running it');
  assert.equal(ran(f.project, 'auto') + ran(f.project, 'click'), 0);
  // The holder is gone: the action may have half run, so it is failed for a person to look at, never run again by itself.
  const gone = { pid: 999999, at: new Date().toISOString() };
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify(producerActions(f.project).map(a => ({ ...a, claim: gone }))));
  runProducerActions(f.project, f.orders);
  const clicked = runProducerAction(f.project, f.orders, 'click');
  for (const a of [stored(f.project, 'auto'), clicked]) {
    assert.equal(a.status, 'failed');
    assert.equal(a.claim, undefined);
    assert.match(a.refusal!, /stopped before it recorded the result; check what it did/);
  }
  assert.equal(ran(f.project, 'auto') + ran(f.project, 'click'), 0);
});

test('a click runs a proposal once and stores its result without dropping an action added meanwhile', () => {
  const f = fixture();
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([f.action('click', { mode: 'propose' })]));
  const done = runProducerAction(f.project, f.orders, 'click');
  assert.deepEqual([done.status, done.result, done.claim], ['done', 'note click', undefined]);
  assert.equal(runProducerAction(f.project, f.orders, 'click').status, 'done');
  assert.equal(ran(f.project, 'click'), 1);
  // An action stored by another process after this one read the list is kept when this one writes.
  const later = f.action('later', { mode: 'propose' });
  writeStateFile(f.project, '_producer-actions.json', JSON.stringify([...producerActions(f.project), later]));
  rejectProducerAction(f.project, 'later', 'not now');
  assert.deepEqual(producerActions(f.project).map(a => [a.id, a.status]).sort(), [['click', 'done'], ['later', 'rejected']]);
});
