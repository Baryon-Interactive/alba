import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lessonPacks } from '../src/config.ts';
import { lessonsForOrder, parseLessons, readLessons } from '../src/lessons/lessons.ts';
import { reviewGuidance, workSystemPrompt } from '../src/producer/work-sessions.ts';
import { planSkills } from '../src/skills/plan.ts';
import { readRegistry, selectSkills } from '../src/skills/registry.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const LIBRARY = ['alba-review-bar', 'game-capture-windows', 'unreal-headless-pipeline', 'unreal-mcp-editor'];

function project(dir: string, extra: Record<string, unknown> = {}) {
  for (const d of ['repo', 'orders']) mkdirSync(path.join(dir, d), { recursive: true });
  return validateProject({ id: 'demo', name: 'Demo', root: path.join(dir, 'repo'), work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'), ...extra }, path.join(dir, 'alba.yaml'));
}

test('skill library: built-in skills are in the registry but go only where they are named; a project skill of the same name wins', () => {
  const { dir, orders } = tempOrders();
  const cfg = project(dir, { skills: { by_kind: { ue: ['unreal-headless-pipeline'] } } });
  const registry = readRegistry(undefined, cfg);
  assert.deepEqual(registry.skills.filter(s => s.library).map(s => s.name), LIBRARY);
  assert.equal(registry.sources.find(s => s.id === 'alba')!.count, 1 + LIBRARY.length);
  // Library skills say their engine like any other; a Unity project naming an Unreal one is told why it is left out.
  assert.deepEqual(Object.fromEntries(registry.skills.filter(s => s.library).map(s => [s.name, s.engines])), { 'alba-review-bar': [], 'game-capture-windows': [], 'unreal-headless-pipeline': ['unreal'], 'unreal-mcp-editor': ['unreal'] });
  const unity = readRegistry(undefined, project(dir, { skills: { engine: 'unity', always: ['unreal-headless-pipeline'] } }));
  assert.equal(unity.skills.find(s => s.name === 'unreal-headless-pipeline')!.inapplicable, 'for unreal, the project is unity');
  assert.ok(unity.skills.find(s => s.name === 'game-capture-windows')!.applicable);
  orders.add({ tag: 'CAP1', title: 'Captures', kind: 'code', tags: ['capture', 'review', 'ue'] });
  orders.add({ tag: 'UE1', title: 'Build', kind: 'ue' });
  // Tags that match a library skill's tags do not select it.
  assert.deepEqual(selectSkills(cfg, registry, orders.get('CAP1'), undefined).selected.map(s => s.skill.name), ['alba-worker-rules']);
  assert.deepEqual(selectSkills(cfg, registry, orders.get('UE1'), undefined).selected.map(s => s.skill.name), ['alba-worker-rules', 'unreal-headless-pipeline']);
  orders.update('CAP1', { skills: ['game-capture-windows'] });
  assert.deepEqual(selectSkills(cfg, registry, orders.get('CAP1'), undefined).selected.map(s => s.skill.name), ['alba-worker-rules', 'game-capture-windows']);
  // The project's own game-capture-windows replaces Alba's.
  const own = path.join(dir, 'skills', 'game-capture-windows');
  mkdirSync(own, { recursive: true });
  writeFileSync(path.join(own, 'SKILL.md'), '---\nname: game-capture-windows\ndescription: ours\n---\n# ours\n');
  const withOwn = readRegistry(undefined, project(dir, { skills: { sources: [{ id: 'mine', dir: path.join(dir, 'skills') }] } }));
  const capture = withOwn.skills.filter(s => s.name === 'game-capture-windows');
  assert.equal(capture.length, 1);
  assert.equal(capture[0]!.source, 'mine');
  assert.deepEqual(withOwn.problems, []);
});

test('an editor pool brings its skills to the runs that use it', () => {
  const { dir, orders } = tempOrders();
  const cfg = project(dir, { dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', caps: { ue: 2 } }, editors: { 'ue-editor': { program: 'UnrealEditor.exe', args: ['-ModelContextProtocolPort={port}'], url: 'http://127.0.0.1:{port}/mcp', cap: 'ue', skills: ['unreal-mcp-editor'], machines: { local: { ports: [8101] } } } } });
  orders.add({ tag: 'MAP1', title: 'Map', kind: 'code', uses: ['ue-editor'] });
  orders.add({ tag: 'SIM1', title: 'Sim', kind: 'code' });
  const map = planSkills(cfg, undefined, orders.get('MAP1')).selection.selected;
  assert.deepEqual(map.map(s => [s.skill.name, s.why]), [['alba-worker-rules', 'always'], ['unreal-mcp-editor', 'tool editor ue-editor']]);
  assert.deepEqual(planSkills(cfg, undefined, orders.get('SIM1')).selection.selected.map(s => s.skill.name), ['alba-worker-rules']);
  assert.throws(() => project(dir, { editors: { x: { program: 'e', args: ['{port}'], url: 'http://127.0.0.1:{port}/mcp', skills: 'unreal-mcp-editor', machines: { local: { ports: [8101] } } } } }), /editors\.x\.skills" must be a list of skill names/);
});

test('lesson packs: Alba ships them, a project turns them on with lessons.packs, next to its own folder or alone', () => {
  const { dir, orders } = tempOrders();
  assert.deepEqual(lessonPacks(), ['art-pipeline', 'deterministic-sim', 'unreal', 'windows-workers']);
  const ids = new Set<string>();
  for (const pack of lessonPacks()) {
    const folder = path.resolve('templates/lessons', pack);
    for (const f of readdirSync(folder)) for (const l of parseLessons(readFileSync(path.join(folder, f), 'utf8'), f)) {
      assert.ok(!ids.has(l.id), `${l.id} twice`); ids.add(l.id);
      assert.match(l.id, /^ALBA-[A-Z]+-\d\d$/);
      assert.ok(l.rule.split('\n').length <= 6, `${l.id} rule has more than 6 lines`);
      assert.ok(l.tags.length && l.why, `${l.id} needs tags and why`);
      assert.doesNotMatch(l.rule + l.why, /History|Recut|Thermopylae|Red Cliffs|HR[A-Z]|hr_sim|tools\/build_ue/);
    }
  }
  mkdirSync(path.join(dir, 'lessons'));
  writeFileSync(path.join(dir, 'lessons', 'own.md'), '## L-01 Our rule\n- tags: engine\n- rule: ours\n');
  const cfg = project(dir, { lessons: { dir: 'lessons', packs: ['unreal', 'windows-workers'], kind_tags: { ue: ['engine', 'build'] } } });
  const all = readLessons(cfg.lessons, cfg);
  assert.ok(all.some(l => l.id === 'L-01') && all.some(l => l.id === 'ALBA-UE-01') && !all.some(l => l.id.startsWith('ALBA-ART')));
  orders.add({ tag: 'UE1', title: 'Build', kind: 'ue' });
  orders.add({ tag: 'DOC1', title: 'Docs', kind: 'docs' });
  const ue = lessonsForOrder(cfg, orders.get('UE1')).map(l => l.id);
  assert.ok(ue.includes('ALBA-UE-02') && ue.includes('L-01') && ue.includes('ALBA-WIN-01'));
  assert.deepEqual(lessonsForOrder(cfg, orders.get('DOC1')).map(l => l.id), ['ALBA-WIN-01', 'ALBA-WIN-02', 'ALBA-WIN-03', 'ALBA-WIN-05', 'ALBA-WIN-06']);
  assert.ok(readLessons(project(dir, { lessons: { packs: ['deterministic-sim'] } }).lessons).every(l => l.id.startsWith('ALBA-SIM')));
  assert.throws(() => project(dir, { lessons: { packs: ['nope'] } }), /"lessons\.packs" must be a list of Alba lesson packs \(art-pipeline, deterministic-sim, unreal, windows-workers\)/);
  assert.throws(() => project(dir, { lessons: {} }), /"lessons\.dir" must be a folder/);
});

test('producer review sessions follow producer.review_skills', () => {
  const { dir } = tempOrders();
  const plain = project(dir);
  assert.equal(reviewGuidance(plain), '');
  const cfg = project(dir, { producer: { enabled: true, review_skills: ['alba-review-bar', 'missing-one'] } });
  const text = workSystemPrompt('review', reviewGuidance(cfg));
  assert.match(text, /Review guidance \(skill alba-review-bar\); follow it as part of the task:\n# Reviewing a delivery: the store bar/);
  assert.match(text, /One picture under several names/);
  assert.doesNotMatch(text, /^name: alba-review-bar/m);
  assert.match(text, /Review guidance "missing-one" is not in the skill registry/);
  assert.ok(text.indexOf('store bar') < text.indexOf('End with exactly one final block'));
  assert.throws(() => project(dir, { producer: { review_skills: 'alba-review-bar' } }), /"producer\.review_skills" must be a list of skill names/);
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('frames.mjs: black frames, flicker outside cuts, identical files and a contact sheet', { skip: !ffmpeg && 'ffmpeg is not on PATH' }, () => {
  const { dir } = tempOrders();
  const frames = path.resolve('templates/skills/game-capture-windows/scripts/frames.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [frames, ...args], { encoding: 'utf8' });
  const clip = path.join(dir, 'c.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:d=2:r=10', '-vf', "eq=brightness='if(eq(n\\,7),0.3,0)':eval=frame", '-pix_fmt', 'yuv420p', clip]);
  const flicker = run('check', clip, '--json');
  assert.equal(flicker.status, 1);
  assert.deepEqual(JSON.parse(flicker.stdout).flicker.frames.map((f: { frame: number }) => f.frame), [7, 8]);
  assert.equal(run('check', clip, '--cuts', '7,8').status, 0);
  for (const [name, color] of [['a.png', 'black'], ['w.png', 'white']]) spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64`, '-frames:v', '1', path.join(dir, name!)]);
  writeFileSync(path.join(dir, 'b.png'), readFileSync(path.join(dir, 'a.png')));
  const pics = run('check', path.join(dir, 'a.png'), path.join(dir, 'w.png'), '--json');
  assert.deepEqual(JSON.parse(pics.stdout).black.frames.map((f: { frame: number }) => f.frame), [0]);
  assert.deepEqual(JSON.parse(pics.stdout).flicker.frames, []);
  const same = run('same', path.join(dir, 'a.png'), path.join(dir, 'b.png'), path.join(dir, 'w.png'));
  assert.equal(same.status, 1);
  assert.match(same.stdout, /same bytes: .*a\.png, .*b\.png/);
  assert.equal(run('sheet', clip, '--out', path.join(dir, 's.png'), '--every', '5', '--tile', '2x2').status, 0);
  const size = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, 's.png')], { encoding: 'utf8' }).stdout.trim();
  assert.equal(size, '960,540');
});

test('mounting never removes a folder outside the mount folder, whatever the worktree list file says', async () => {
  const { mountSkills } = await import('../src/skills/mount.ts');
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { dir } = tempOrders();
  const tree = path.join(dir, 'tree');
  mkdirSync(path.join(tree, '.agents', 'skills'), { recursive: true });
  execFileSync('git', ['init', '-q', tree]);
  const victim = path.join(dir, 'victim');
  mkdirSync(victim); writeFileSync(path.join(victim, 'keep.txt'), 'x');
  writeFileSync(path.join(tree, '.agents', 'skills', '.alba-skills.json'), JSON.stringify({ version: 1, skills: { '../../../victim': 'x', '..': 'x', ok: 'x' } }));
  mkdirSync(path.join(tree, '.agents', 'skills', 'ok'));
  const r = mountSkills(tree, ['.agents/skills'], []);
  assert.ok(existsSync(path.join(victim, 'keep.txt')), 'the folder outside is still there');
  assert.ok(existsSync(path.join(tree, '.agents')), 'the mount folder itself is still there');
  assert.equal(existsSync(path.join(tree, '.agents', 'skills', 'ok')), false, 'a real skill of the list is removed');
  assert.equal(r.problems.filter(p => /outside the folder; not removed/.test(p)).length, 2);
});
