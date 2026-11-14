import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';
import { foundationGaps, foundationNotice, foundationStates, orderTraits } from '../src/foundations/foundations.ts';
import { startRun } from '../src/run/launch.ts';
import { createOrder } from '../src/service/new-order.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { planTick, type TickOrder } from '../src/tick/plan.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository with an art bible (approved), a palette (draft) and an empty scale sheet; `foundations` as given. */
function fixture(foundations?: unknown) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(path.join(root, 'design'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'design', 'art-bible.md'), '# Art bible\n\nWarm dusk, high contrast.\n');
  writeFileSync(path.join(root, 'design', 'palette.md'), '# Palette\n\n#c84b31\n');
  writeFileSync(path.join(root, 'design', 'scale.md'), '\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(workOrders);
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
    design_docs: { files: [{ id: 'art-bible', path: 'design/art-bible.md', status: 'approved' }, { id: 'palette', path: 'design/palette.md', status: 'draft' }] },
    ...(foundations !== undefined ? { foundations } : {}),
  }, path.join(dir, 'alba.yaml'));
  return { orders, project, root, workOrders, dir };
}

const probes = (): Probes => ({
  now: () => new Date('2026-01-01T12:00:00Z'), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}),
  fileTime: () => undefined, isAlive: () => true, tail: () => '', readText: () => undefined,
  spawnDetached: () => 4242,
} as unknown as Probes);

const workers = () => validateWorkers({
  workers: [{ id: 'coder', engine: 'codex-cli', launch: { template: 'coder-v1', program: 'coder', args: ['exec', '-C', '{cwd}', '-o', '{last_file}', 'Read the UTF-8 file {prompt_file} in full and follow it exactly.'] } }],
}, 'w.yaml');

test('foundations: optional; a set needs kinds or tags and docs; paths stay inside the project', () => {
  assert.equal(fixture().project.foundations, undefined);
  const { project } = fixture({ art: { kinds: ['Art', 'visual'], docs: ['art-bible', 'palette', 'design/scale.md'] }, ui: { tags: [' hud '], docs: ['ui-kit'], mode: 'block' } });
  assert.deepEqual(project.foundations, { mode: 'warn', sets: [
    { name: 'art', mode: 'warn', kinds: ['art', 'visual'], tags: [], docs: ['art-bible', 'palette', 'design/scale.md'] },
    { name: 'ui', mode: 'block', kinds: [], tags: ['hud'], docs: ['ui-kit'] },
  ] });
  assert.throws(() => fixture({ mode: 'stop', art: { kinds: ['art'], docs: ['a'] } }), /"foundations\.mode" must be warn or block/);
  assert.throws(() => fixture({ art: { docs: ['a'] } }), /"foundations\.art" needs kinds or tags/);
  assert.throws(() => fixture({ art: { kinds: ['art'], docs: [] } }), /"foundations\.art\.docs" must be a nonempty list/);
  assert.throws(() => fixture({ art: { kinds: ['art'], docs: ['../outside.md'] } }), /must be a path inside the project/);
  assert.throws(() => fixture({ art: { kinds: ['art'], docs: ['a'], owner: 'me' } }), /unknown key\(s\) under "foundations\.art": owner/);
  assert.throws(() => fixture({ mode: 'warn' }), /"foundations" names no set/);
});

test('foundations: design documents count when approved, files when they have text; orders match by kind or tag, "foundation" orders never', () => {
  const { project, orders } = fixture({ mode: 'block', art: { kinds: ['art'], docs: ['art-bible', 'palette', 'design/scale.md', 'design/lighting.md', 'look-targets'] }, hud: { tags: ['hud'], docs: ['art-bible'] } });
  const [art, hud] = foundationStates(project);
  assert.deepEqual(art.documents.map(d => [d.ref, d.source, d.status, d.ok]), [
    ['art-bible', 'design-doc', 'approved', true], ['palette', 'design-doc', 'draft', false], ['design/scale.md', 'file', 'empty', false],
    ['design/lighting.md', 'file', 'missing', false], ['look-targets', 'none', 'missing', false],
  ]);
  assert.equal(art.ready, false);
  assert.equal(hud.ready, true);
  orders.add({ tag: 'A1', title: 'Hero', kind: 'art' });
  orders.add({ tag: 'A2', title: 'Bible', kind: 'art', tags: ['foundation'] });
  orders.add({ tag: 'D1', title: 'Docs', kind: 'docs' });
  orders.add({ tag: 'H1', title: 'HUD', kind: 'code', tags: ['hud'] });
  const gaps = (tag: string) => foundationGaps(foundationStates(project), orderTraits(project, orders.get(tag))).map(s => s.name);
  assert.deepEqual([gaps('A1'), gaps('A2'), gaps('D1'), gaps('H1')], [['art'], [], [], []]);
  // A file-backed design document that is missing on disk is missing, whatever its status says.
  const gone = fixture({ art: { kinds: ['art'], docs: ['art-bible'] } });
  writeFileSync(path.join(gone.root, 'design', 'art-bible.md'), '');
  assert.equal(foundationStates(gone.project)[0].documents[0].status, 'empty');
});

test('foundations: orders add says what is missing (warn) or that the order will wait (block); without the section, nothing', () => {
  const warn = fixture({ art: { kinds: ['art'], docs: ['art-bible', 'palette'] } });
  const made = createOrder(warn.project, warn.orders, { tag: 'A1', title: 'Hero', kind: 'art' });
  assert.equal(made.foundationWarning, 'The "art" foundations are not ready (palette: draft, not approved): write and approve them before content orders (alba foundations).');
  assert.equal(createOrder(warn.project, warn.orders, { tag: 'D1', title: 'Docs', kind: 'docs' }).foundationWarning, undefined);
  const block = fixture({ mode: 'block', art: { kinds: ['art'], docs: ['palette'] } });
  assert.match(foundationNotice(block.project, createOrder(block.project, block.orders, { tag: 'A1', title: 'Hero', kind: 'art' }).doc) ?? '', /A1 will not start until they are/);
  const none = fixture();
  assert.equal(createOrder(none.project, none.orders, { tag: 'A1', title: 'Hero', kind: 'art' }).foundationWarning, undefined);
});

const order = (over: Partial<TickOrder>): TickOrder => ({ role: { id: 'default' }, tag: 'A1', stage: 'queued', kind: 'art', row: 1, rework: false, resume: false, endedWithoutReport: false, ...over });
const worker = (): WorkerConfig => ({
  id: 'w1', engine: 'codex-cli', paid: false, concurrency: 4, capabilities: [], cost: 'included', aliases: [], enabled: true, disabled_when: [], card_only: false,
  launch: { id: 'w1', program: 'codex', args: ['exec', '{prompt_file}'], env: {}, env_unset: [] },
} as WorkerConfig);

test('foundations in the tick plan: block holds a queued order back, warn starts it; one problem line per set', () => {
  const gap = (mode: 'warn' | 'block') => [{ set: 'art', mode, missing: 'palette: draft, not approved' }];
  const input = (orders: TickOrder[]) => ({ now: new Date('2026-01-01T12:00:00Z'), orders, activity: {}, workers: [{ config: worker(), available: true, reasons: [], running: 0, runsToday: 0 }], caps: {}, reworkReserve: 0, alerts: [] });
  const blocked = planTick(input([order({ foundations: gap('block') }), order({ tag: 'A2', row: 2, foundations: gap('block') }), order({ tag: 'D1', row: 3, kind: 'docs' })]));
  assert.deepEqual(blocked.moves.map(m => m.tag), ['D1']);
  assert.deepEqual(blocked.heldBack, [{ tag: 'A1', why: 'the "art" foundations are not ready (palette: draft, not approved)' }, { tag: 'A2', why: 'the "art" foundations are not ready (palette: draft, not approved)' }]);
  assert.deepEqual(blocked.problems, [{ kind: 'foundations', text: 'The "art" foundations are not ready (palette: draft, not approved); held back until they are: A1, A2.' }]);
  assert.equal(blocked.exitCode, 2);
  const warned = planTick(input([order({ foundations: gap('warn') }), order({ tag: 'A0', stage: 'running', foundations: gap('warn') })]));
  assert.deepEqual(warned.moves.map(m => m.tag), ['A1']);
  assert.deepEqual(warned.problems.map(p => p.text), ['The "art" foundations are not ready (palette: draft, not approved); going ahead without them: A1, A0.']);
  const clean = planTick(input([order({})]));
  assert.deepEqual([clean.problems, clean.moves.map(m => m.tag)], [[], ['A1']]);
});

test('foundations, block: the tick holds the order back and no start goes through until the document is approved', () => {
  const f = fixture({ mode: 'block', art: { kinds: ['art'], docs: ['palette'] } });
  writeFileSync(path.join(f.workOrders, 'A1-hero.md'), '# A1\nHero.\n');
  writeFileSync(path.join(f.workOrders, 'D1-docs.md'), '# D1\nDocs.\n');
  createOrder(f.project, f.orders, { tag: 'A1', title: 'Hero', kind: 'art', queue: true });
  createOrder(f.project, f.orders, { tag: 'D1', title: 'Docs', kind: 'docs', queue: true });
  const report = tick(f.project, f.orders, workers(), probes(), { record: false }).report;
  assert.deepEqual(report.heldBack.filter(h => h.tag === 'A1').map(h => h.why), ['the "art" foundations are not ready (palette: draft, not approved)']);
  assert.ok(report.problems.some(p => p.kind === 'foundations' && /held back until they are: A1\./.test(p.text)));
  assert.ok(report.moves.some(m => m.tag === 'D1'));
  const ctx = { project: f.project, orders: f.orders, workers: workers(), probes: probes() };
  assert.throws(() => startRun(ctx, 'A1', 'coder'), /A1 cannot start now: the "art" foundations are not ready \(palette: draft, not approved\)\./);
  assert.equal(f.orders.get('A1').runs.length, 0);
  // Approved: it starts.
  f.project.design_docs!.files[1].status = 'approved';
  assert.equal(tick(f.project, f.orders, workers(), probes(), { record: false }).report.problems.filter(p => p.kind === 'foundations').length, 0);
  assert.equal(startRun(ctx, 'A1', 'coder').mode, 'start');
});

test('alba foundations: each set with its documents and the orders it holds back; exit 1 while one is not ready', () => {
  const { dir } = tempOrders();
  mkdirSync(path.join(dir, 'design'), { recursive: true });
  writeFileSync(path.join(dir, 'design', 'art-bible.md'), '# Art bible\n');
  const file = projectDir(dir, 'design_docs: { files: [{ id: art-bible, path: design/art-bible.md, status: draft }] }\nfoundations:\n  mode: block\n  art: { kinds: [art], docs: [art-bible, design/palette.md] }\n');
  const added = alba(file, ['orders', 'add', 'A1', '--title', 'Hero', '--kind', 'art']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /The "art" foundations are not ready \(art-bible: draft, not approved; design\/palette\.md: missing\): A1 will not start until they are/);
  const r = alba(file, ['foundations']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /^art  \[block\]  kinds art  NOT READY$/m);
  assert.match(r.out, /^  --  art-bible\s+draft, not approved  design\/art-bible\.md$/m);
  assert.match(r.out, /^  --  design\/palette\.md\s+missing$/m);
  assert.match(r.out, /^  held back: A1 \(draft\)$/m);
  const json = JSON.parse(alba(file, ['foundations', '--json']).out);
  assert.deepEqual([json.configured, json.sets[0].ready, json.orders.art], [true, false, [{ tag: 'A1', stage: 'draft' }]]);
  const none = alba(projectDir(path.join(dir, 'other')), ['foundations']);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /has no "foundations:" section/);
});
