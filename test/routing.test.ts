import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { chooseWorker, type Choosable } from '../src/routing/choose.ts';
import { classifyByRules, classifyOrders, matchKinds, parseClassifierAnswer, routingOf } from '../src/routing/classify.ts';
import { workerHistory } from '../src/routing/history.ts';
import { routeFor } from '../src/routing/route.ts';
import { createOrder } from '../src/service/new-order.ts';
import { planTick, type TickInput, type TickOrder, type WorkerState } from '../src/tick/plan.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

const cfg = (over: Record<string, unknown> = {}): WorkerConfig => validateWorkers({ workers: [{ id: 'w', engine: 'x', ...over }] }, 'w.yaml').workers[0];
const state = (config: WorkerConfig, over: Partial<Choosable> = {}): Choosable => ({ config, available: true, reasons: [], running: 0, runsToday: 0, ...over });
const input = (kind: string, over: Record<string, unknown> = {}) => ({ kind, tags: [] as string[], ...over });

function project(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'game'), { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const config = validateProject({
    id: 'demo', name: 'Demo', root: path.join(dir, 'game'), work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    kinds: {
      ue: { description: 'Unreal Engine work', match: String.raw`(?<![A-Za-z])UE(?![A-Za-z])` },
      web: { description: 'Web pages and TypeScript', match: [String.raw`\.tsx\b`, 'vite'] },
      visual: { description: 'Needs a look at pictures', match: 'screenshot', ignore_case: true, tag_only: true },
      docs: { description: 'Writing', match: 'README' },
    },
    ...extra,
  }, path.join(dir, 'alba.yaml'));
  return { orders, dir, config };
}

test('workers: notes and cost are read; obsolete fields and wrong values are refused', () => {
  const w = cfg({ notes: 'Long runs.', cost: 'included', paid: true });
  assert.equal(w.notes, 'Long runs.');
  assert.equal('profile' in w, false);
  assert.equal('fits' in w, false);
  assert.equal('kinds' in w, false);
  assert.equal(w.cost, 'included');
  assert.equal(cfg({ paid: true }).cost, 'paid');         // the default follows `paid`
  assert.equal(cfg({}).cost, 'included');
  assert.throws(() => cfg({ fits: { ue: 4 } }), /unknown key/);
  assert.throws(() => cfg({ cost: 'free' }), /"cost" must be "included"/);
  assert.throws(() => cfg({ skills_mount: ['../x'] }), /inside a worktree/);
});

test('kinds: the vocabulary and the classifier are validated', () => {
  assert.throws(() => validateProject({ id: 'a', name: 'A', root: '.', work_orders: '.', state_dir: 's', kinds: { ue: { description: 'x', match: '(' } } }, 'f.yaml'), /not a valid regular expression/);
  assert.throws(() => validateProject({ id: 'a', name: 'A', root: '.', work_orders: '.', state_dir: 's', kinds: { ue: { match: 'x' } } }, 'f.yaml'), /description/);
  const p = validateProject({ id: 'a', name: 'A', root: '.', work_orders: '.', state_dir: 's', kinds: { ue: 'Unreal work' }, classifier: { worker: 'w', max_chars: 100 } }, 'f.yaml');
  assert.deepEqual(p.kinds, [{ id: 'ue', description: 'Unreal work', match: [], ignore_case: false, tag_only: false, title_only: false }]);
  assert.deepEqual(p.classifier, { worker: 'w', max_chars: 100, timeout_seconds: 180, max_per_pass: 10, parallel: 1 });
});

test('classification: a kind from the table or a person wins; rules read title and text; extra tags come from rules; nothing matched stays unclassified', () => {
  const { orders, dir, config } = project();
  writeFileSync(path.join(dir, 'orders', 'A1-x.md'), '# A1\nChange the .tsx page and take a Screenshot.\n');
  writeFileSync(path.join(dir, 'orders', 'A2-x.md'), '# A2\nBuild the UE package. Look at the screenshot.\n');
  writeFileSync(path.join(dir, 'orders', 'A3-x.md'), '# A3\nNothing special here.\n');
  orders.add({ tag: 'A1', title: 'Page', kind: 'task' });
  orders.add({ tag: 'A2', title: 'Package', kind: 'task' });
  orders.add({ tag: 'A3', title: 'Other', kind: 'task' });
  orders.add({ tag: 'A4', title: 'Given', kind: 'docs' });                                       // a person gave the kind
  orders.add({ tag: 'A5', title: 'From a row', kind: 'ue', source: { status_word: 'todo', row: 4 } });
  const at = '2026-01-01T00:00:00Z';
  const a1 = classifyByRules(config, orders.get('A1'), 'Change the .tsx page and take a Screenshot.', at);
  assert.deepEqual([a1.kind, a1.source, a1.tags], ['web', 'rules', ['visual']]);                  // visual is only ever an extra tag
  assert.match(a1.why, /matched "\.tsx" \(web\), "Screenshot" \(visual\)/);
  const a2 = routingOf(config, orders.get('A2'));
  assert.deepEqual([a2.kind, a2.source, a2.tags], ['ue', 'rules', ['visual']]);
  const a3 = routingOf(config, orders.get('A3'));
  assert.deepEqual([a3.kind, a3.source, a3.tags], ['', 'none', []]);
  const a4 = routingOf(config, orders.get('A4'));
  assert.deepEqual([a4.kind, a4.source], ['docs', 'manual']);
  const a5 = routingOf(config, orders.get('A5'));
  assert.deepEqual([a5.kind, a5.source], ['ue', 'table']);
  // an order's own tags that are kinds count as extra tags
  orders.update('A4', { tags: ['visual'] });
  assert.deepEqual(routingOf(config, orders.get('A4')).tags, ['visual']);
});

test('kinds: a rule with title_only looks at the title alone', () => {
  const kinds = validateProject({
    id: 'a', name: 'A', root: '.', work_orders: '.', state_dir: 's',
    kinds: { ue: { description: 'Unreal', match: 'UE', title_only: true }, docs: { description: 'Writing', match: 'README' } },
  }, 'f.yaml').kinds!;
  assert.deepEqual(matchKinds(kinds, 'Fix the menu', 'This also touches UE and the README').map(h => h.kind), ['docs']);
  assert.deepEqual(matchKinds(kinds, 'Fix the menu (UE)', 'the README').map(h => h.kind), ['ue', 'docs']);
});

test('classification: the model is asked only when the rules decide nothing; its answer is kept until the text changes; a failure leaves the order unclassified', async () => {
  const { orders, dir, config } = project({ classifier: { worker: 'asker', max_per_pass: 5 } });
  writeFileSync(path.join(dir, 'orders', 'B1-x.md'), '# B1\nTune the shader.\n');
  writeFileSync(path.join(dir, 'orders', 'B2-x.md'), '# B2\nUE work.\n');
  writeFileSync(path.join(dir, 'orders', 'B3-x.md'), '# B3\nSomething odd.\n');
  for (const tag of ['B1', 'B2', 'B3']) orders.add({ tag, title: tag, kind: 'task' });
  const workers = validateWorkers({ workers: [{ id: 'asker', engine: 'x', launch: { program: 'asker', args: ['--last', '{last_file}', '{prompt_file}'] } }] }, 'w.yaml');
  const asked: string[] = [];
  const answers: Record<string, string> = { B1: '{"kind":"ue","tags":["visual","nonsense"],"why":"a shader is engine work"}', B3: 'I think it is a poem' };
  const fs = await import('node:fs');
  const probes = {
    now: () => new Date('2026-01-01T00:00:00Z'), readText: (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
    async runWorkerOnce(job: { args: string[] }) {
      const prompt = fs.readFileSync(job.args[2], 'utf8');
      const tag = /Order (B\d)/.exec(prompt)![1];
      asked.push(tag);
      assert.match(prompt, /- ue: Unreal Engine work/);
      assert.match(prompt, /- visual \(tag only\): Needs a look at pictures/);
      fs.writeFileSync(job.args[1], answers[tag] ?? '');
      return { code: 0, timedOut: false };
    },
  } as unknown as Probes;
  const done = await classifyOrders({ project: config, orders, workers, probes }, { model: true });
  assert.deepEqual(asked.sort(), ['B1', 'B3']);                                                   // B2 was placed by the rules
  const by = Object.fromEntries(done.map(o => [o.tag, o]));
  assert.deepEqual([by.B1.routing.kind, by.B1.routing.source, by.B1.routing.tags], ['ue', 'model', ['visual']]);
  assert.match(by.B1.routing.why, /asker: a shader is engine work/);
  assert.equal(by.B2.routing.source, 'rules');
  assert.equal(by.B3.routing.source, 'none');
  assert.match(by.B3.problem!, /no JSON/);
  // stored, and still used while the text is the same; not asked again
  assert.equal(orders.get('B1').order.routing?.source, 'model');
  assert.equal(routingOf(config, orders.get('B1')).source, 'model');
  asked.length = 0;
  await classifyOrders({ project: config, orders, workers, probes }, { tags: ['B1'], model: true });
  assert.deepEqual(asked, []);
  // the text changes: the old answer is no longer valid
  writeFileSync(path.join(dir, 'orders', 'B1-x.md'), '# B1\nWrite the README.\n');
  assert.deepEqual([routingOf(config, orders.get('B1')).kind, routingOf(config, orders.get('B1')).source], ['docs', 'rules']);
  assert.deepEqual(parseClassifierAnswer(config, '{"kind":"poetry"}'), { problem: 'the classifier answered kind "poetry", which the project does not have' });
  assert.deepEqual(parseClassifierAnswer(config, 'blah {"kind":"web","tags":["ue"],"why":"x"} trailing'), { kind: 'web', tags: ['ue'], why: 'x' });
});

test('a new order is classified by the rules and keeps the result; a project with no kinds stores nothing', () => {
  const { orders, config } = project();
  const made = createOrder(config, orders, { tag: 'N1', title: 'Fix the vite config', body: 'The vite build is slow.\n' });
  assert.equal(made.doc.order.routing?.kind, 'web');
  assert.equal(made.doc.order.kind, 'task');                                                      // the board's default stays; the routing says what it is
  const plain = project({ kinds: undefined });
  const p = createOrder(plain.config, plain.orders, { tag: 'N2', title: 'x', kind: 'sim' });
  assert.equal(p.doc.order.routing, undefined);
});

test('history: a run counts once it has a verdict; imported and unfinished runs do not; the rate needs 3', () => {
  const { orders } = tempOrders();
  const w = validateWorkers({ workers: [{ id: 'coder', engine: 'x', aliases: ['Coder'] }] }, 'w.yaml').workers;
  const go = (tag: string, verdict: 'approve' | 'rework') => {
    orders.add({ tag, title: tag, kind: 'ue' }); orders.act(tag, 'queue');
    orders.runStart(tag, { worker: 'coder' }); orders.runEnd(tag); orders.report(tag, { status: 'ready', summary: 's', evidence: [], commits: [] });
    if (verdict === 'approve') orders.act(tag, 'approve', { force: true }); else orders.act(tag, 'rework', { note: 'again' });
  };
  go('H1', 'approve'); go('H2', 'approve');
  let h = workerHistory(orders.all(), w).coder.ue;
  assert.deepEqual([h.accepted, h.reworked, h.samples, h.rate], [2, 0, 2, undefined]);
  go('H3', 'rework');
  h = workerHistory(orders.all(), w).coder.ue;
  assert.deepEqual([h.accepted, h.reworked, h.samples], [2, 1, 3]);
  assert.ok(Math.abs(h.rate! - 2 / 3) < 1e-9);
  orders.add({ tag: 'H4', title: 'x', kind: 'ue' }); orders.act('H4', 'queue'); orders.runStart('H4', { worker: 'coder' }, true);       // imported: no
  orders.add({ tag: 'H5', title: 'x', kind: 'ue' }); orders.act('H5', 'queue'); orders.runStart('H5', { worker: 'coder' }); orders.runEnd('H5');   // no verdict yet
  assert.equal(workerHistory(orders.all(), w).coder.ue.samples, 3);
});

