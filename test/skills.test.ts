import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from './state-helper.ts';
import { parseReportBlock } from '../src/orders/report.ts';
import { startRun } from '../src/run/launch.ts';
import { buildPrompt } from '../src/run/prompt.ts';
import { mountSkills, mountsFor } from '../src/skills/mount.ts';
import { CORE_SKILL, readFrontMatter, readRegistry, selectSkills, validateSkillSources } from '../src/skills/registry.ts';
import { skillsView, orderSkillsView } from '../src/skills/view.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';

/** Alba's built-in skill library (templates/skills, besides the core rules): listed, used only where named. */
const LIBRARY = ['alba-review-bar', 'game-capture-windows', 'unreal-headless-pipeline', 'unreal-mcp-editor'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function skill(dir: string, name: string, description: string, extra = '', files: Record<string, string> = {}): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, name, rel)), { recursive: true }); writeFileSync(path.join(dir, name, rel), text); }
}

/** A source as the workers file would write it (what `validateSkillSources` read, without what it worked out). */
const asRaw = (s: { id: string; dir: string; layout: string; tags: string[]; skills: Record<string, string[]>; exclude: string[] }) => ({ id: s.id, dir: s.dir, layout: s.layout, tags: s.tags, skills: s.skills, exclude: s.exclude });

/** A shared source of skills, and a registry that reads it. */
function shared(dir: string) {
  const lib = path.join(dir, 'lib');
  skill(lib, 'unreal-engine', 'Unreal Engine habits. Use for UE work.', 'tags: [ue]\n', { 'refs/api.md': 'api notes' });
  skill(lib, 'web-basics', 'Web pages with TypeScript.');
  skill(lib, 'writing', 'How to write short documents.', '', { 'node_modules/ignored.txt': 'x', '.git/ignored': 'x' });
  skill(lib, 'secret-art', 'Art rules.');
  mkdirSync(path.join(lib, 'not-a-skill'), { recursive: true });
  const config = validateSkillSources({ sources: [{ id: 'lib', dir: lib, tags: ['shared'], skills: { 'web-basics': { tags: ['web'] }, writing: { tags: ['docs'] } }, exclude: ['secret-art'] }] }, path.join(dir, 'workers.yaml'));
  return { lib, config };
}

test('registry: the core skill and every source are read; front matter gives name, description and tags; the registry adds tags; excluded and duplicate names are handled', () => {
  const { dir } = tempOrders();
  const { lib, config } = shared(dir);
  skill(path.join(dir, 'second'), 'web-basics', 'A second copy of a name.');
  const two = validateSkillSources({ sources: [...config.sources.map(asRaw), { id: 'second', dir: path.join(dir, 'second') }, { id: 'gone', dir: path.join(dir, 'missing') }] }, path.join(dir, 'workers.yaml'));
  const reg = readRegistry(two);
  assert.deepEqual(reg.skills.map(s => s.name), [CORE_SKILL, ...LIBRARY, 'unreal-engine', 'web-basics', 'writing']);
  const by = Object.fromEntries(reg.skills.map(s => [s.name, s]));
  assert.deepEqual(by['unreal-engine'].tags, ['ue', 'shared']);
  assert.deepEqual(by['web-basics'].tags, ['shared', 'web']);
  assert.equal(by['unreal-engine'].description, 'Unreal Engine habits. Use for UE work.');
  assert.equal(by['unreal-engine'].files, 2);                                                       // SKILL.md and refs/api.md
  assert.equal(by.writing.files, 1);                                                                // .git and node_modules are not counted
  assert.equal(by[CORE_SKILL].source, 'alba');
  assert.ok(reg.problems.some(p => /skill "web-basics" is in lib and in second; the first one is used/.test(p)));
  assert.ok(reg.problems.some(p => /skill source gone: .*missing does not exist/.test(p)));
  assert.deepEqual(reg.sources.map(s => [s.id, s.count, s.exists]), [['alba', 1 + LIBRARY.length, true], ['lib', 3, true], ['second', 0, true], ['gone', 0, false]]);
  assert.deepEqual(readFrontMatter('---\nname: a\ndescription: >\n  long\n  text\ntags: x, y\n---\nbody'), { name: 'a', description: 'long text', tags: ['x', 'y'], engines: [] });
  assert.ok(existsSync(path.join(lib, 'secret-art', 'SKILL.md')));
});

test('registry: sources come from the workers file and a skills.yaml next to it; a bad source is refused', () => {
  const { dir } = tempOrders();
  const { lib } = shared(dir);
  mkdirSync(path.join(dir, 'cfg'));
  writeFileSync(path.join(dir, 'cfg', 'skills.yaml'), `sources:\n  - { id: more, dir: ../lib, layout: recursive, tags: [extra] }\n`);
  const w = validateWorkers({ workers: [{ id: 'a', engine: 'x' }], skills: { sources: [{ id: 'inline', dir: lib }] } }, path.join(dir, 'cfg', 'workers.yaml'));
  assert.deepEqual(w.skills!.sources.map(s => [s.id, s.layout]), [['inline', 'dirs'], ['more', 'recursive']]);
  assert.equal(w.skills!.sources[1].dir, path.resolve(lib));                                       // relative folders start at the file's folder
  assert.throws(() => validateSkillSources({ sources: [{ id: 'Bad Id', dir: '.' }] }, 'x.yaml'), /"id" must be lower-case/);
  assert.throws(() => validateSkillSources({ sources: [{ id: 'a', dir: '.' }, { id: 'a', dir: '.' }] }, 'x.yaml'), /appears twice/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'a', engine: 'x', launch: { program: 'p', args: [], env: { X: '{nonsense}' } } }] }, 'w.yaml'), /unknown placeholder \{nonsense\} in "env"/);
});

function selectionFixture(extra: Record<string, unknown> = {}) {
  const { orders, dir } = tempOrders();
  const { config } = shared(dir);
  mkdirSync(path.join(dir, 'game'), { recursive: true });
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: path.join(dir, 'game'), work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), ...extra }, path.join(dir, 'alba.yaml'));
  return { orders, dir, project, registry: readRegistry(config) };
}

test('skills: three layers (core always; project always and by kind; the order by name and by tags), each once, with the reason', () => {
  const { orders, project, registry } = selectionFixture({ skills: { always: ['writing'], by_kind: { ue: ['web-basics', 'no-such-skill'] } } });
  orders.add({ tag: 'S1', title: 'Package', kind: 'ue' });
  orders.add({ tag: 'S2', title: 'Page', kind: 'task', tags: ['web'], skills: ['unreal-engine'] });
  orders.add({ tag: 'S3', title: 'Plain', kind: 'task' });
  const s1 = selectSkills(project, registry, orders.get('S1'), { kind: 'ue', tags: [] });
  assert.deepEqual(s1.selected.map(s => [s.skill.name, s.layer, s.why]), [[CORE_SKILL, 'core', 'always'], ['writing', 'project', 'always (project)'], ['web-basics', 'project', 'kind ue'], ['unreal-engine', 'order', 'tag ue']]);
  assert.deepEqual(s1.problems, ['skills.by_kind.ue names the skill "no-such-skill", which is not in the registry.']);
  const s2 = selectSkills(project, registry, orders.get('S2'), undefined);
  assert.deepEqual(s2.selected.map(s => [s.skill.name, s.layer, s.why]), [[CORE_SKILL, 'core', 'always'], ['writing', 'project', 'always (project)'], ['unreal-engine', 'order', 'named on the order'], ['web-basics', 'order', 'tag web']]);
  const s3 = selectSkills(project, registry, orders.get('S3'), { kind: '', tags: [] });
  assert.deepEqual(s3.selected.map(s => s.skill.name), [CORE_SKILL, 'writing']);
  // extra tags from the classification select skills too, and the cap keeps the named ones
  const capped = selectionFixture({ skills: { max_per_order: 2 } });
  capped.orders.add({ tag: 'C1', title: 'x', kind: 'ue', skills: ['writing'] });
  const c = selectSkills(capped.project, capped.registry, capped.orders.get('C1'), { kind: 'ue', tags: ['web'] });
  assert.deepEqual(c.selected.map(s => s.skill.name), [CORE_SKILL, 'writing']);
  assert.equal(c.truncated, 2);                                                                   // unreal-engine and web-basics matched by tag but the cap was reached
});

function repo(dir: string) {
  const root = path.join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first');
  const tree = path.join(dir, 'tree');
  git(root, 'worktree', 'add', '-q', '-b', 'b1', tree, 'main');
  return { root, tree };
}

test('mount: skills are copied (not linked) into the worktree, named in the repository\'s exclude file, removed when no longer selected, and nothing else is touched', () => {
  const { dir } = tempOrders();
  const { config } = shared(dir);
  const reg = readRegistry(config);
  const pick = (...names: string[]) => reg.skills.filter(s => names.includes(s.name)).map(skill => ({ skill, layer: 'order' as const, why: 'x' }));
  const { root, tree } = repo(dir);
  const first = mountSkills(tree, ['.agents/skills'], pick('unreal-engine', 'writing'));
  assert.deepEqual(first.mounted, ['unreal-engine', 'writing']);
  assert.equal(readFileSync(path.join(tree, '.agents/skills/unreal-engine/refs/api.md'), 'utf8'), 'api notes');
  assert.ok(!existsSync(path.join(tree, '.agents/skills/writing/node_modules')));
  assert.equal(git(tree, 'status', '--porcelain').trim(), '');                                      // never shows as a change
  const exclude = readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
  assert.match(exclude, /\/\.agents\/skills\/unreal-engine\//);
  assert.match(exclude, /\/\.agents\/skills\/\.alba-skills\.json/);
  // a second run with the same selection copies nothing; a changed source is copied again
  assert.deepEqual(mountSkills(tree, ['.agents/skills'], pick('unreal-engine', 'writing')).unchanged, ['unreal-engine', 'writing']);
  writeFileSync(path.join(dir, 'lib', 'writing', 'SKILL.md'), '---\nname: writing\ndescription: Changed text.\n---\n');
  assert.deepEqual(mountSkills(tree, ['.agents/skills'], readRegistry(config).skills.filter(s => s.name === 'writing').map(skill => ({ skill, layer: 'order' as const, why: 'x' }))).unchanged, []);
  // not selected any more: removed; a folder of the project's own stays
  mkdirSync(path.join(tree, '.agents/skills/own'), { recursive: true });
  writeFileSync(path.join(tree, '.agents/skills/own/SKILL.md'), 'mine');
  const next = mountSkills(tree, ['.agents/skills'], pick('web-basics'));
  assert.deepEqual([next.mounted, next.removed], [['web-basics'], ['writing']]);
  assert.deepEqual(readdirSync(path.join(tree, '.agents/skills')).filter(n => !n.startsWith('.')).sort(), ['own', 'web-basics']);
  // a folder that exists and is not ours, and one that git tracks, are left alone and reported
  mkdirSync(path.join(tree, '.agents/skills/unreal-engine'), { recursive: true });
  writeFileSync(path.join(tree, '.agents/skills/unreal-engine/SKILL.md'), 'not ours');
  const clash = mountSkills(tree, ['.agents/skills'], pick('unreal-engine'));
  assert.deepEqual(clash.mounted, []);
  assert.match(clash.problems[0], /\.agents\/skills\/unreal-engine exists and was not put there by alba; left alone/);
  assert.equal(readFileSync(path.join(tree, '.agents/skills/unreal-engine/SKILL.md'), 'utf8'), 'not ours');
  git(tree, 'add', '-f', '.agents/skills/own'); git(tree, 'commit', '-q', '-m', 'own');
  mkdirSync(path.join(tree, '.opencode/skills/writing'), { recursive: true });
  writeFileSync(path.join(tree, '.opencode/skills/writing/SKILL.md'), 'tracked');
  git(tree, 'add', '-f', '.opencode/skills/writing'); git(tree, 'commit', '-q', '-m', 'tracked');
  const tracked = mountSkills(tree, ['.opencode/skills'], pick('writing'));
  assert.match(tracked.problems[0], /is tracked by git|exists and was not put there/);
  // where each engine reads
  assert.deepEqual(mountsFor({ engine: 'codex-cli' }), ['.agents/skills']);
  assert.deepEqual(mountsFor({ engine: 'opencode' }), ['.opencode/skills']);
  assert.deepEqual(mountsFor({ engine: 'opencode', skills_mount: ['.claude/skills', '.opencode/skills'] }), ['.claude/skills', '.opencode/skills']);
  assert.deepEqual(mountsFor({ engine: 'unknown' }), ['.agents/skills']);
});

function runFixture() {
  const { orders, dir } = tempOrders();
  const { config } = shared(dir);
  const { root, tree: _unused } = repo(dir);
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  writeFileSync(path.join(dir, 'orders', 'K1-pack.md'), '# K1\nPack the UE build.\n');
  const project = validateProject({
    id: 'demo', name: 'Demo', root, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), skills: { by_kind: { ue: ['writing'] } },
    kinds: { ue: { description: 'Unreal Engine work', match: String.raw`\bUE\b` } }, dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
  }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({
    workers: [{ id: 'oc', engine: 'opencode', launch: { program: 'oc', args: ['{prompt_file}'], env: { OPENCODE_PERMISSION: '{"skill":{"*":"deny",{skill_allow}}}', NAMES: '{skill_names}' } } }],
    skills: { sources: config.sources.map(asRaw) },
  }, path.join(dir, 'workers.yaml'));
  workers.skills = config;
  const spawned: { args: string[]; env: Record<string, string> }[] = [];
  const probes = { now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined, isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: (_p: string, args: string[], o: { env: Record<string, string> }) => { spawned.push({ args, env: o.env }); return 7; } } as unknown as Probes;
  return { orders, dir, project, workers, probes, spawned };
}

test('a run: the skills of the order are put into the worktree before the process starts, listed in the prompt, recorded on the run; the launch environment names them; the choice of worker is recorded', () => {
  const f = runFixture();
  f.orders.add({ tag: 'K1', title: 'Pack', kind: 'task', skills: ['web-basics'] }); f.orders.act('K1', 'queue');
  const started = startRun({ project: f.project, orders: f.orders, workers: f.workers, probes: f.probes }, 'K1', 'oc', { route: { why: 'oc: fit 2 for ue, included', rejected: [{ worker: 'other', reason: 'does not take kind "ue" (fit 0)' }] } });
  assert.equal(started.mode, 'start');
  const cwd = (started as { cwd: string }).cwd;
  const names = readdirSync(path.join(cwd, '.opencode/skills')).filter(n => !n.startsWith('.')).sort();
  assert.deepEqual(names, [CORE_SKILL, 'unreal-engine', 'web-basics', 'writing']);                 // core, kind ue (project), tag ue, named
  assert.equal(git(cwd, 'status', '--porcelain').trim(), '');
  const run = f.orders.get('K1').runs[0];
  assert.deepEqual(run.skills!.slice().sort(), names);
  assert.deepEqual(run.routing, { kind: 'ue', why: 'oc: fit 2 for ue, included', rejected: [{ worker: 'other', reason: 'does not take kind "ue" (fit 0)' }] });
  const startEvent = f.orders.store.events().find(e => e.type === 'run-start')!;
  assert.deepEqual((startEvent.data as { routing: { why: string } }).routing.why, 'oc: fit 2 for ue, included');
  const prompt = readFileSync(run.prompt_file!, 'utf8');
  assert.match(prompt, /## Skills for this order/);
  assert.match(prompt, /\| alba-worker-rules \| How a worker started by Alba \(alba\) must work and report\./);
  assert.match(prompt, /\| unreal-engine \| Unreal Engine habits\. \| \.opencode\/skills\/unreal-engine\/SKILL\.md \|/);
  assert.match(prompt, /Follow the skill `alba-worker-rules`/);
  assert.match(prompt, /--- alba-report ---/);                                                      // a one-line summary stays in the prompt itself
  const env = f.spawned[0].env;
  assert.equal(env.NAMES.split(',').sort().join(','), names.join(','));
  assert.deepEqual(Object.keys(JSON.parse(env.OPENCODE_PERMISSION).skill).sort(), ['*', ...names].sort());
  assert.equal(JSON.parse(env.OPENCODE_PERMISSION).skill['*'], 'deny');
  // the next run follows the registry as it is then: a skill dropped from the order leaves the worktree
  f.orders.runEnd('K1'); f.orders.update('K1', { skills: [] }); f.orders.act('K1', 'queue', { force: true });
  startRun({ project: f.project, orders: f.orders, workers: f.workers, probes: f.probes }, 'K1', 'oc');
  assert.ok(!existsSync(path.join(cwd, '.opencode/skills/web-basics')));
  assert.ok(existsSync(path.join(cwd, '.opencode/skills/unreal-engine')));
  assert.match(f.orders.get('K1').runs[1].routing!.why, /role default/);
});

test('the prompt: a skills table only when there are skills; the footer points at the core skill and keeps the report marker', () => {
  assert.doesNotMatch(buildPrompt({ orderFile: 'o.md', recovery: false }), /Skills for this order/);
  const p = buildPrompt({ orderFile: 'o.md', recovery: false, skills: [{ name: 'a', description: 'First sentence. Second sentence.', layer: 'order', why: 'x', path: '.agents/skills/a/SKILL.md' }] });
  assert.match(p, /\| a \| First sentence\. \| \.agents\/skills\/a\/SKILL\.md \|/);
  assert.ok(p.indexOf('Skills for this order') < p.indexOf('--- alba-report ---'));
});

test('reports: skill_suggestions are read from the block and kept on the report; the order lists them', () => {
  const r = parseReportBlock('x\n--- alba-report ---\n{"status":"ready","summary":"s","evidence":[],"commits":[],"skill_suggestions":[{"path":"unreal-engine/SKILL.md","reason":"the build flag is wrong"}]}\n--- end ---\n');
  assert.deepEqual(r.skill_suggestions, [{ path: 'unreal-engine/SKILL.md', reason: 'the build flag is wrong' }]);
  assert.throws(() => parseReportBlock('--- alba-report ---\n{"status":"ready","summary":"s","skill_suggestions":["x"]}\n--- end ---\n'), /skill_suggestions/);
  const f = runFixture();
  f.orders.add({ tag: 'K1', title: 'Pack', kind: 'ue' });
  f.orders.report('K1', r);
  const view = orderSkillsView(f.project, f.workers, f.orders.get('K1'));
  assert.deepEqual(view.suggestions.map(s => [s.path, s.reason]), [['unreal-engine/SKILL.md', 'the build flag is wrong']]);
  assert.deepEqual(view.skills.map(s => s.name), [CORE_SKILL, 'writing', 'unreal-engine']);
  assert.deepEqual(view.mountedAt, ['.opencode/skills']);       // no run yet: the folders of the workers that could take it
  const all = skillsView(f.project, f.workers, f.orders);
  const ue = all.skills.find(s => s.name === 'unreal-engine')!;
  assert.deepEqual([ue.layers, ue.usedBy.orders], [['order'], ['K1']]);
  assert.deepEqual(all.skills.find(s => s.name === 'writing')!.layers, ['project']);
  assert.deepEqual(all.skills.find(s => s.name === CORE_SKILL)!.layers, ['core']);
  assert.deepEqual(all.mounts, [{ worker: 'oc', engine: 'opencode', mounts: ['.opencode/skills'] }]);
});

test('api: skills and classification resolve a role; workers expose supply only', async () => {
  const lib = (dir: string) => { const { config } = shared(dir); return config; };
  const f = await fixture({ project: () => ({ kinds: { ue: { description: 'Unreal', match: String.raw`\bUE\b` }, sim: { description: 'Simulation', match: 'tick' } }, skills: { always: ['writing'] } }) });
  f.board.ctx.workers = validateWorkers({
    roles: { sim: { kinds: ['sim'], workers: { prefer: ['coder'], avoid: ['editor'] } } },
    workers: [{ id: 'coder', engine: 'x', notes: 'Does the sim work.', capabilities: ['cheap'], concurrency: 3, cost: 'included', aliases: ['Coder'], launch: { program: 'coder', args: ['{prompt_file}'] } }, { id: 'editor', engine: 'claude-session' }],
  }, path.join(f.dir, 'workers.yaml'));
  f.board.ctx.workers!.skills = lib(f.dir);
  f.board.ctx.invalidate();
  const skills = (await f.get('/api/skills')).body;
  assert.deepEqual(skills.skills.map((s: { name: string }) => s.name), [CORE_SKILL, ...LIBRARY, 'unreal-engine', 'web-basics', 'writing']);
  assert.deepEqual(skills.always, ['writing']);
  assert.deepEqual(skills.mounts, [{ worker: 'coder', engine: 'x', mounts: ['.agents/skills'] }]);
  assert.equal(skills.sources[0].id, 'alba');
  const mine = (await f.get('/api/orders/W1/skills')).body;
  assert.deepEqual(mine.skills.map((s: { name: string }) => s.name), [CORE_SKILL, 'writing']);
  assert.equal(mine.skills[0].path, '.agents/skills/alba-worker-rules/SKILL.md');
  // the choice of worker for a queued order, and classifying again
  f.orders.add({ tag: 'P1', title: 'Fix the tick order', kind: 'task' });
  const route = (await f.get('/api/orders/P1/route')).body;
  assert.deepEqual([route.routing.kind, route.routing.source], ['sim', 'rules']);
  assert.deepEqual([route.outcome, route.chosen], ['chosen', 'coder']);
  assert.match(route.why, /coder: role sim, included, role preference 1/);
  assert.equal(route.candidates.find((c: { worker: string }) => c.worker === 'editor').verdict, 'unfit');
  assert.equal((await f.post('/api/orders/P1/classify', {})).status, 401);                          // a write needs the token
  const again = await f.write('/api/orders/P1/classify', {});
  assert.equal(again.status, 200);
  assert.equal(f.orders.get('P1').order.routing?.kind, 'sim');
  assert.equal((await f.get('/api/orders/P1')).body.order.routing.kind, 'sim');
  assert.equal((await f.get('/api/orders')).body.items.find((i: { tag: string }) => i.tag === 'P1').kind, 'sim');
  const worker = (await f.get('/api/workers')).body.workers.find((w: { id: string }) => w.id === 'coder');
  assert.deepEqual([worker.notes, worker.capabilities, worker.cost], ['Does the sim work.', ['cheap'], 'included']);
  assert.deepEqual([worker.profile, worker.fits, worker.kinds, worker.history], [undefined, undefined, undefined, undefined]);
  // a new order with skills named, classified by the rules on creation
  const made = await f.write('/api/orders', { tag: 'P2', title: 'Package for UE', kind: 'task', skills: ['web-basics'] });
  assert.equal(made.status, 201);
  const detail = (await f.get('/api/orders/P2')).body;
  assert.deepEqual([detail.order.skills, detail.order.routing.kind], [['web-basics'], 'ue']);
  assert.equal((await f.get('/api/orders/NOPE/route')).status, 404);
});

test('cli: alba skills, alba route and alba classify', () => {
  const { dir } = tempOrders();
  const { lib } = shared(dir);
  const file = projectDir(path.join(dir, 'p'), `kinds:\n  web: { description: Web pages, match: '\\.tsx' }\nskills:\n  always: [writing]\nworkers: ../workers.yaml\n`);
  writeFileSync(path.join(dir, 'workers.yaml'), `roles:\n  web: { kinds: [web], workers: { prefer: [coder], avoid: [other] } }\nworkers:\n  - { id: coder, engine: x, notes: Web work, launch: { program: coder, args: ['{prompt_file}'] } }\n  - { id: other, engine: x, launch: { program: other, args: ['{prompt_file}'] } }\nskills:\n  sources:\n    - { id: lib, dir: ${JSON.stringify(lib)}, tags: [shared] }\n`);
  writeFileSync(path.join(dir, 'p', 'orders', 'T1-x.md'), '# T1\nChange the page.tsx.\n');
  assert.equal(alba(file, ['orders', 'add', 'T1', '--title', 'Page', '--queue', '--skills', 'unreal-engine']).code, 0);
  writeFileSync(path.join(dir, 'p', 'orders', 'T2-x.md'), '# T2\n');
  assert.equal(alba(file, ['orders', 'add', 'T2', '--title', 'Other', '--kind', 'sim', '--queue']).code, 0);
  const skills = alba(file, ['skills']);
  assert.match(skills.out, /Sources:\n\s+alba\s.*\n\s+lib\s/);
  assert.match(skills.out, /alba-worker-rules\s+\[alba\]\s+alba,core\s+core/);
  assert.match(skills.out, /writing\s+\[lib\]\s+shared\s+project/);
  assert.match(skills.out, /coder \(x\): \.agents\/skills/);
  const mine = alba(file, ['skills', '--order', 'T1']);
  assert.match(mine.out, /T1 gets 3 skill\(s\), put into \.agents\/skills of its worktree:/);
  assert.match(mine.out, /unreal-engine\s+\[order: named on the order\]/);
  const route = alba(file, ['route']);
  assert.equal(route.code, 0, route.err);
  assert.match(route.out, /T1  \[queued\]  web \(rules: matched "\.tsx" \(web\)\)  → coder/);
  assert.match(route.out, /coder \[chosen\]: coder: role web, included, role preference 1/);
  assert.match(route.out, /other \[does not take it\]: avoided by role/);
  assert.match(route.out, /T2  \[queued\]  sim \(manual: the kind was given\)  → coder/);
  assert.match(route.out, /2 order\(s\): 2 would start now, 0 nobody takes, 0 wait for a worker\./);
  const json = JSON.parse(alba(file, ['route', 'T1', '--json']).out);
  assert.deepEqual([json[0].chosen, json[0].outcome], ['coder', 'chosen']);
  const classified = alba(file, ['classify', 'T1']);
  assert.match(classified.out, /^T1  web  \(rules: matched/);
});
