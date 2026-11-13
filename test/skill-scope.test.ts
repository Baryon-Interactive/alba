import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, validateProject, testBackend } from './state-helper.ts';
import { CORE_SKILL, readRegistry, selectSkills, validateSkillSources } from '../src/skills/registry.ts';
import { setSkillUse } from '../src/skills/use.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';

function skill(dir: string, name: string, description: string, extra = ''): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`);
}

/** A source as the workers file would write it (what `validateSkillSources` read, without what it worked out). */
const asRaw = (s: { id: string; dir: string; layout: string; tags: string[]; skills: Record<string, string[]>; exclude: string[] }) => ({ id: s.id, dir: s.dir, layout: s.layout, tags: s.tags, skills: s.skills, exclude: s.exclude });

/** A library that groups skills by engine (`unity/`, `godot/`) next to ones for any engine, as community libraries do. */
function library(dir: string) {
  const lib = path.join(dir, 'engine-lib');
  skill(path.join(lib, 'unity'), 'unity-ui', 'Unity UI Toolkit.');
  skill(path.join(lib, 'godot'), 'gd-basics', 'GDScript basics.');
  skill(path.join(lib, 'unreal'), 'ue-build', 'Unreal builds.');
  skill(lib, 'writing', 'Short documents.', 'tags: [docs, ui]\n');
  skill(lib, 'ue-tools', 'Tools.', 'engines: [UE5]\n');
  skill(lib, 'unity-only', 'By its front matter.', 'engine: unity\n');
  const config = validateSkillSources({ sources: [{ id: 'engine-lib', dir: lib, layout: 'recursive', skills: { 'ue-build': { tags: ['build'] } } }] }, path.join(dir, 'workers.yaml'));
  return { lib, config };
}

const skillsBlock = (over: Record<string, unknown>) => ({ always: [], by_kind: {}, max_per_order: 16, sources: [], include: [], exclude: [], ...over });
const verdicts = (reg: ReturnType<typeof readRegistry>) => Object.fromEntries(reg.skills.filter(s => !s.core && !s.library).map(s => [s.name, s.applicable ? 'yes' : s.inapplicable]));

test('skills by engine: the folders unity/ and godot/ and the front matter engines give the engine; a skill for another engine is not used; a skill for none is for every engine', () => {
  const { dir } = tempOrders();
  const { config } = library(dir);
  const all = readRegistry(config);
  assert.deepEqual(Object.fromEntries(all.skills.filter(s => !s.library).map(s => [s.name, s.engines])), { [CORE_SKILL]: [], 'unity-ui': ['unity'], 'gd-basics': ['godot'], 'ue-build': ['unreal'], writing: [], 'ue-tools': ['unreal'], 'unity-only': ['unity'] });
  assert.ok(Object.values(verdicts(all)).every(v => v === 'yes'), 'without a project nothing is filtered');
  const unreal = readRegistry(config, { skills: skillsBlock({ engine: 'unreal' }) });
  assert.deepEqual(verdicts(unreal), { 'unity-ui': 'for unity, the project is unreal', 'gd-basics': 'for godot, the project is unreal', 'ue-build': 'yes', writing: 'yes', 'ue-tools': 'yes', 'unity-only': 'for unity, the project is unreal' });
  assert.ok(Object.values(verdicts(readRegistry(config, { skills: skillsBlock({ engine: 'any' }) }))).every(v => v === 'yes'));
  assert.ok(Object.values(verdicts(readRegistry(config, { skills: skillsBlock({}) }))).every(v => v === 'yes'), 'no engine declared: no filter');
});

test('skills: include lets a skill of another engine in; exclude (by name or tag) keeps one out and wins over include', () => {
  const { dir } = tempOrders();
  const { config } = library(dir);
  const read = (include: string[], exclude: string[]) => verdicts(readRegistry(config, { skills: skillsBlock({ engine: 'unreal', include, exclude }) }));
  assert.equal(read(['unity-ui'], [])['unity-ui'], 'yes');
  assert.equal(read(['unity'], [])['unity-ui'], 'for unity, the project is unreal', 'a rule by tag matches tags, not engines');
  assert.equal(read([], ['writing']).writing, 'excluded by name');
  assert.equal(read([], ['ui']).writing, 'excluded by tag ui');
  assert.equal(read(['writing', 'unity-ui'], ['Writing']).writing, 'excluded by name', 'exclude wins over include, whatever the case');
  assert.equal(read(['ui'], ['writing']).writing, 'excluded by name');
});

test('skills: the project\'s own sources come first, shadow a global skill of the same name, and are always usable', () => {
  const { dir } = tempOrders();
  const { config } = library(dir);
  const own = path.join(dir, 'game-skills');
  skill(own, 'writing', 'The project\'s own writing rules.');
  skill(own, 'unity-glue', 'Glue for the project.', 'engine: unity\n');
  const project = validateProject({
    id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'),
    skills: { engine: 'ue', exclude: ['writing', 'unity-glue'], sources: [{ id: 'own', dir: 'game-skills' }] },
  }, path.join(dir, 'alba.yaml'));
  assert.equal(project.skills!.engine, 'unreal');
  assert.equal(project.skills!.sources[0].dir, path.resolve(own), 'relative to the project file');
  const reg = readRegistry(config, project);
  const writing = reg.skills.find(s => s.name === 'writing')!;
  assert.deepEqual([writing.source, writing.scope, writing.applicable], ['own', 'project', true]);
  assert.ok(reg.problems.some(p => /skill "writing" is in own and in engine-lib; the first one is used/.test(p)));
  assert.equal(reg.skills.find(s => s.name === 'unity-glue')!.applicable, true, 'the project\'s own skills are not filtered');
  assert.deepEqual(reg.sources.map(s => [s.id, s.scope]), [['alba', 'global'], ['own', 'project'], ['engine-lib', 'global']]);
});

test('skills: an order never gets a skill the project does not use, by tag or by name; the name is reported', () => {
  const { dir, orders } = tempOrders();
  const { config } = library(dir);
  const project = validateProject({
    id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'),
    skills: { engine: 'unreal', always: ['unity-ui'], by_kind: { ue: ['gd-basics'] } },
  }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'E1', title: 'A UE thing', kind: 'ue', tags: ['unity', 'build', 'docs'], skills: ['unity-only'] });
  const chosen = selectSkills(project, readRegistry(config, project), orders.get('E1'), { kind: 'ue', tags: ['unity'] });
  assert.deepEqual(chosen.selected.map(s => s.skill.name), [CORE_SKILL, 'ue-build', 'writing']);
  assert.deepEqual(chosen.problems.map(p => p.replace(/^.* names the skill /, '')), [
    '"unity-ui", which this project does not use (for unity, the project is unreal).',
    '"gd-basics", which this project does not use (for godot, the project is unreal).',
    '"unity-only", which this project does not use (for unity, the project is unreal).',
  ]);
});

test('project skills config: engine, include, exclude and sources are validated', () => {
  const { dir } = tempOrders();
  const make = (skills: unknown) => validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), skills }, path.join(dir, 'alba.yaml'));
  assert.throws(() => make({ engine: 'cryengine' }), /"skills.engine" must be one of unreal, unity, godot, other, any/);
  assert.throws(() => make({ include: 'a' }), /"skills.include" must be a list of skill names/);
  assert.throws(() => make({ sources: [{ id: 'x' }] }), /"dir" must be a folder/);
  assert.deepEqual([make({ include: [' a '], exclude: ['b'] }).skills!.include, make({ engine: 'Unity' }).skills!.engine], [['a'], 'unity']);
});

test('use / do not use: the project file gets include and exclude written with its comments kept; a skill kept out by a tag rule is refused', () => {
  const { dir } = tempOrders();
  const { config } = library(dir);
  const file = path.join(dir, 'alba.yaml');
  const text = `# the project\nid: demo\nname: Demo\nroot: .\nwork_orders: .\nstate_dir: state\nstate: { backend: ${testBackend()} }\nroles: { default: {} }\n\nskills:\n  # which skills\n  engine: unreal   # not unity\n  always: [writing]\n`;
  writeFileSync(file, text);
  const skillOf = (name: string) => readRegistry(config, loadProject(file)).skills.find(s => s.name === name)!;

  const off = setSkillUse(file, skillOf('ue-tools'), false, loadProject(file));
  assert.deepEqual(off.changed, ['skills.exclude']);
  assert.equal(readFileSync(file, 'utf8'), text.replace('  always: [writing]\n', '  always: [writing]\n  exclude:\n    - ue-tools\n'));
  assert.ok(off.backup && readFileSync(off.backup, 'utf8') === text);
  assert.equal(skillOf('ue-tools').applicable, false);

  const on = setSkillUse(file, skillOf('ue-tools'), true, loadProject(file));
  assert.deepEqual(on.changed, ['skills.exclude']);
  assert.equal(readFileSync(file, 'utf8'), text, 'back to what it was: the empty list is removed, nothing else moved');

  const unity = setSkillUse(file, skillOf('unity-ui'), true, loadProject(file));
  assert.deepEqual(unity.changed, ['skills.include']);
  assert.match(readFileSync(file, 'utf8'), /include:\n {4}- unity-ui/);
  assert.equal(skillOf('unity-ui').applicable, true);
  assert.deepEqual(setSkillUse(file, skillOf('unity-ui'), true, loadProject(file)).changed, [], 'already in use: nothing written');

  const byTag = text.replace('engine: unreal', 'engine: unreal\n  exclude: [ui]');
  writeFileSync(file, byTag);
  assert.throws(() => setSkillUse(file, skillOf('writing'), true, loadProject(file)), /writing stays out: excluded by tag ui/);
  assert.throws(() => setSkillUse(file, skillOf(CORE_SKILL), false, loadProject(file)), /not filtered/);
  assert.equal(readFileSync(file, 'utf8'), byTag);
});

test('api: /api/skills/use changes what the project uses, answers 404 for a skill that is not there, records skills.edited and the next view shows it', async () => {
  const dirs = tempOrders().dir;
  const { config } = library(dirs);
  const f = await fixture({ populate: false, project: () => ({ skills: { engine: 'unreal' } }) });
  const file = f.board.ctx.projects[0].file;
  writeFileSync(file, `id: demo\nname: Demo\nroot: ${JSON.stringify(f.root)}\nwork_orders: ${JSON.stringify(path.join(f.root, 'orders'))}\nstate_dir: ${JSON.stringify(path.join(f.dir, 'state'))}\nskills:\n  engine: unreal\n`);
  f.board.ctx.workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x' }], skills: { sources: config.sources.map(asRaw) } }, path.join(dirs, 'workers.yaml'));
  f.board.ctx.projects[0] = loadProject(file);

  const before = (await f.get('/api/skills')).body;
  assert.equal(before.engine, 'unreal');
  const unity = before.skills.find((s: { name: string }) => s.name === 'unity-ui');
  assert.deepEqual([unity.applicable, unity.inapplicable, unity.scope, unity.engines], [false, 'for unity, the project is unreal', 'global', ['unity']]);
  assert.equal(before.skills.find((s: { name: string }) => s.name === 'writing').applicable, true);

  assert.equal((await f.write('/api/skills/use', { name: 'nothing', use: true })).status, 404);
  assert.equal((await f.write('/api/skills/use', { name: 'writing' })).status, 400);
  const off = await f.write('/api/skills/use', { name: 'writing', use: false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.changed, ['skills.exclude']);
  const after = (await f.get('/api/skills')).body;
  assert.deepEqual(after.exclude, ['writing']);
  const writing = after.skills.find((s: { name: string }) => s.name === 'writing');
  assert.deepEqual([writing.applicable, writing.excluded, writing.inapplicable], [false, true, 'excluded by name']);
  const event = f.orders.store.events().find(e => e.type === 'skills.edited');
  assert.deepEqual([event!.by, event!.data!.skill, event!.data!.use], ['web', 'writing', false]);
  const noToken = await fetch(f.base + '/api/skills/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"writing","use":true}' });
  assert.equal(noToken.status, 401);
});

test('cli: alba skills lists what the project can use, then what it cannot with the reason; --applicable leaves out the second list', () => {
  const { dir } = tempOrders();
  const { lib } = library(dir);
  const project = projectDir(dir, 'skills:\n  engine: unreal\n');
  writeFileSync(path.join(dir, 'workers.yaml'), `workers:\n  - { id: coder, engine: x }\nskills:\n  sources:\n    - { id: engine-lib, dir: ${JSON.stringify(lib)}, layout: recursive }\n`);
  const out = alba(project, ['--workers', path.join(dir, 'workers.yaml'), 'skills']);
  assert.equal(out.code, 0, out.err);
  const [usable, other] = out.out.split('Not applicable to this project:');
  assert.match(usable, /Skills this project can use \(engine unreal\):/);
  assert.match(usable, /ue-build/);
  assert.doesNotMatch(usable, /unity-ui|gd-basics/);
  assert.match(other, /unity-ui .*for unity, the project is unreal/);
  assert.match(other, /gd-basics .*for godot, the project is unreal/);
  const only = alba(project, ['--workers', path.join(dir, 'workers.yaml'), 'skills', '--applicable']);
  assert.doesNotMatch(only.out, /Not applicable/);
});

test('skills by engine: a skill that declares nothing is for the engine its name or tags say (unity-ui, godot-guide, tag ue); engines: [any] says every engine', () => {
  const { dir } = tempOrders();
  const lib = path.join(dir, 'flat-lib');
  skill(lib, 'unity-cli', 'Unity from the command line.');
  skill(lib, 'godot-dev-guide', 'Godot.');
  skill(lib, 'engine-notes', 'Tagged by engine.', 'tags: [Unity, notes]\n');
  skill(lib, 'unreal-plugin', 'Unreal plugins.');
  skill(lib, 'unity-vs-unreal', 'A comparison.');
  skill(lib, 'unity-tips-for-all', 'Declared for every engine.', 'engines: [any]\n');
  skill(lib, 'community-tips', 'Not an engine word.');
  const config = validateSkillSources({ sources: [{ id: 'flat', dir: lib }] }, path.join(dir, 'workers.yaml'));
  const reg = readRegistry(config, { skills: skillsBlock({ engine: 'unreal' }) });
  assert.deepEqual(Object.fromEntries(reg.skills.filter(s => !s.core && !s.library).map(s => [s.name, s.engines])), {
    'unity-cli': ['unity'], 'godot-dev-guide': ['godot'], 'engine-notes': ['unity'], 'unreal-plugin': ['unreal'], 'unity-vs-unreal': ['unity', 'unreal'], 'unity-tips-for-all': [], 'community-tips': [],
  });
  assert.deepEqual(verdicts(reg), {
    'unity-cli': 'for unity, the project is unreal', 'godot-dev-guide': 'for godot, the project is unreal', 'engine-notes': 'for unity, the project is unreal', 'unreal-plugin': 'yes', 'unity-vs-unreal': 'yes', 'unity-tips-for-all': 'yes', 'community-tips': 'yes',
  });
});
