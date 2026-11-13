import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { lessonsFor, lessonsSection, parseLessons, readLessons } from '../src/lessons/lessons.ts';
import { startRun } from '../src/run/launch.ts';
import { buildPrompt, promptFor } from '../src/run/prompt.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { git } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';

const LIBRARY = `# Lessons

Some words before the first lesson.

## L012 Never hand-edit generated assets
- tags: art, ui
- rule: Change the source file and export again; never edit the exported image.
- why: A hand edit was lost at the next export.

## L013: Keep saves small
- tags: perf
- rule: Keep a save file under 1 MB
  and write it in one go.

## L014 All orders
- tags: all
- rule: Run the project's own checks before reporting ready.

## Notes
This heading is not a lesson.

## L015 Has no rule
- tags: art

### L016 Wrapped field rules
- tags: visual,ui
- rule: Check dimensions before export.
`;

test('lessons: sections with an id and a rule are read; tags, why and wrapped rules are kept', () => {
  const lessons = parseLessons(LIBRARY, 'main.md');
  assert.deepEqual(lessons.map(l => l.id), ['L012', 'L013', 'L014', 'L016']);
  assert.deepEqual(lessons[0], { id: 'L012', title: 'Never hand-edit generated assets', tags: ['art', 'ui'], rule: 'Change the source file and export again; never edit the exported image.', why: 'A hand edit was lost at the next export.', file: 'main.md', appliesToProject: true, orders: [] });
  assert.deepEqual([lessons[1].title, lessons[1].tags, lessons[1].rule], ['Keep saves small', ['perf'], 'Keep a save file under 1 MB\nand write it in one go.']);
  assert.deepEqual(lessons[3].tags, ['visual', 'ui']);
});

test('lessons: an order gets the lessons of its tags and those tagged all, in id order', () => {
  const lessons = parseLessons(LIBRARY, 'main.md');
  assert.deepEqual(lessonsFor(lessons, ['UI']).map(l => l.id), ['L012', 'L014', 'L016']);
  assert.deepEqual(lessonsFor(lessons, ['perf']).map(l => l.id), ['L013', 'L014']);
  assert.deepEqual(lessonsFor(lessons, undefined).map(l => l.id), ['L014']);
  assert.deepEqual(lessonsFor(lessons, ['nothing']).map(l => l.id), ['L014']);
  assert.deepEqual(lessonsSection([]), []);
  const text = buildPrompt({ orderFile: 'o.md', lessons: lessonsFor(lessons, ['perf']), recovery: false });
  assert.match(text, /## Lessons from earlier work/);
  assert.match(text, /- L013 Keep saves small: Keep a save file under 1 MB\n  and write it in one go\./);
  assert.match(text, /- L014 All orders: Run the project's own checks/);
  assert.ok(text.indexOf('Lessons from earlier work') < text.indexOf('--- alba-report ---'), 'the lessons come before the report footer');
  assert.doesNotMatch(buildPrompt({ orderFile: 'o.md', recovery: false }), /Lessons/);
});

test('lessons: alba run writes them into the prompt file, alba prompt prints them, alba lessons lists them', () => {
  const { dir, orders } = tempOrders();
  const root = path.join(dir, 'game');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  mkdirSync(path.join(dir, 'lessons'));
  writeFileSync(path.join(dir, 'lessons', 'main.md'), LIBRARY);
  mkdirSync(path.join(dir, 'orders'));
  writeFileSync(path.join(dir, 'orders', 'T1-thing.md'), '# T1\n');
  const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), lessons: { dir: path.join(dir, 'lessons') }, dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  assert.equal(readLessons(project.lessons).length, 4);
  orders.add({ tag: 'T1', title: 'Thing', kind: 'task', tags: ['Perf'] });
  orders.act('T1', 'queue');
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', launch: { program: 'coder', args: ['{prompt_file}'] } }] }, 'w.yaml');
  const spawned: string[] = [];
  const probes = { now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: (_p: string, args: string[]) => { spawned.push(args[0]); return 1; } } as unknown as Probes;
  const started = startRun({ project, orders, workers, probes }, 'T1', 'coder');
  assert.equal(started.mode, 'start');
  const prompt = readFileSync(spawned[0], 'utf8');
  assert.match(prompt, /L013 Keep saves small/);
  assert.match(prompt, /L014 All orders/);
  assert.doesNotMatch(prompt, /L012/);
  assert.match(promptFor(project.work_orders, orders.get('T1'), lessonsFor(readLessons(project.lessons), ['art'])), /L012 Never hand-edit/);

  // the command line, on a project file of its own
  const file = projectDir(path.join(dir, 'cli'), `lessons:\n  dir: ../lessons\n`);
  writeFileSync(path.join(dir, 'cli', 'orders', 'T2-x.md'), '# T2\n');
  assert.equal(alba(file, ['orders', 'add', 'T2', '--title', 'Two', '--kind', 'task', '--tags', 'ui,art']).code, 0);
  assert.match(alba(file, ['prompt', 'T2']).out, /L012 Never hand-edit generated assets/);
  const all = alba(file, ['lessons']);
  assert.match(all.out, /L013\s+Keep saves small\s+\[perf\]/);
  const some = JSON.parse(alba(file, ['lessons', '--tag', 'perf', '--json']).out);
  assert.deepEqual(some.items.map((l: { id: string }) => l.id), ['L013', 'L014']);
  assert.match(alba(file, ['orders', 'show', 'T2']).out, /T2/);
});

test('api: the library and the lessons of an order are listed; an order lists its tags', async () => {
  const f = await fixture({ project: (dir) => { mkdirSync(path.join(dir, 'lib')); writeFileSync(path.join(dir, 'lib', 'main.md'), LIBRARY); return { lessons: { dir: path.join(dir, 'lib') } }; } });
  const all = (await f.get('/api/lessons')).body;
  assert.equal(all.count, 4);
  assert.deepEqual(all.items[0], { id: 'L012', title: 'Never hand-edit generated assets', tags: ['art', 'ui'], rule: 'Change the source file and export again; never edit the exported image.', why: 'A hand edit was lost at the next export.', file: 'main.md', appliesToProject: true, orders: [] });
  assert.deepEqual((await f.get('/api/lessons?tag=perf')).body.items.map((l: { id: string }) => l.id), ['L013', 'L014']);
  const made = await f.write('/api/orders', { tag: 'L1', title: 'Tagged', kind: 'task', tags: ['art'] });
  assert.equal(made.status, 201);
  const detail = (await f.get('/api/orders/L1')).body;
  assert.deepEqual(detail.lessons.map((l: { id: string }) => l.id), ['L012', 'L014']);
  assert.deepEqual(detail.order.tags, ['art']);
  assert.deepEqual((await f.get('/api/orders/W1')).body.lessons.map((l: { id: string }) => l.id), ['L014']);      // the ones for all
  const plain = await fixture();
  assert.equal((await plain.get('/api/lessons')).body.count, 0);
});
