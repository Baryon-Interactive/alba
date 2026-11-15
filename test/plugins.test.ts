import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readManifest } from '../src/plugins/manifest.ts';
import { BUILTIN_PLUGINS, discoverPlugins, validatePlugins } from '../src/plugins/registry.ts';
import { checkToolEnvironment, orderTools, toolsPrompt, withToolServers } from '../src/plugins/tools.ts';
import { doctorTool } from '../src/plugins/doctor.ts';
import { mountRole } from '../src/roles/mount.ts';
import { validateWorkers } from '../src/workers/config.ts';
import type { OrderDoc } from '../src/orders/model.ts';

const temp = () => mkdtempSync(path.join(tmpdir(), 'alba-plugins-'));
const slash = (p: string) => path.resolve(p).replace(/\\/g, '/');

/** A plugin folder with a manifest (YAML text) and, when asked, a skill. */
function plugin(root: string, id: string, manifest: string, skill = true): string {
  const dir = path.join(root, id);
  mkdirSync(path.join(dir, 'skills', id), { recursive: true });
  if (skill) writeFileSync(path.join(dir, 'skills', id, 'SKILL.md'), `---\nname: ${id}\ndescription: How to use ${id}.\n---\n\nUse it.\n`);
  writeFileSync(path.join(dir, 'alba-plugin.yaml'), manifest);
  return dir;
}
const manifest = (id: string, extra = '') => `id: ${id}\nversion: 1.0.0\napiVersion: 1\nkinds: [tool]\ndescription: The ${id} tool.\nagent:\n  mcp:\n    ${id.replace(/-/g, '_')}:\n      command: ${id}-mcp\n      args: [--stdio, "\${plugin}/data"]\n      env_from: [${id.toUpperCase().replace(/-/g, '_')}_KEY]\n      tools: [quote, make]\n  skill: skills/${id}\n${extra}`;

test('manifest: a tool is read with its servers, skill and ${plugin} paths; later keys, values of secrets and broken parts are refused by name', () => {
  const root = temp();
  const dir = plugin(root, 'mesh', manifest('mesh', 'resources: { mesh-wallet: { slots: 2 } }\nmachines: { probe: [mesh, --version] }\n'));
  const m = readManifest(path.join(dir, 'alba-plugin.yaml'));
  assert.equal(m.id, 'mesh'); assert.equal(m.apiVersion, 1);
  assert.deepEqual(m.agent.mcp.mesh, { command: 'mesh-mcp', args: ['--stdio', `${slash(dir)}/data`], env_from: ['MESH_KEY'], tools: ['quote', 'make'] });
  assert.equal(m.agent.skill, `${slash(dir)}/skills/mesh`);
  assert.deepEqual(m.resources, { 'mesh-wallet': { slots: 2 } });
  assert.deepEqual(m.machines, { probe: ['mesh', '--version'] });
  const refused = (text: string, skill: boolean, pattern: RegExp) => {
    const d = plugin(temp(), 'mesh', text, skill);
    assert.throws(() => readManifest(path.join(d, 'alba-plugin.yaml')), pattern);
  };
  refused(manifest('mesh', 'checks: [c.mjs]\n'), true, /checks: not supported yet/);
  refused(manifest('mesh', 'operations: {}\n'), true, /operations: a mapping of operation names/);
  refused(manifest('mesh').replace('apiVersion: 1', 'apiVersion: 2'), true, /apiVersion: this Alba reads apiVersion 1; the plugin says 2/);
  refused(manifest('mesh').replace('      env_from: [MESH_KEY]', '      env: { MESH_KEY: secret-value }'), true, /agent\.mcp\.mesh\.env: values are not allowed/);
  refused(manifest('mesh'), false, /agent\.skill: skills\/mesh\/SKILL\.md does not exist/);
  refused(manifest('mesh', 'colour: red\n'), true, /colour: unknown key/);
  refused(manifest('mesh').replace('skill: skills/mesh', 'skill: ../elsewhere'), true, /agent\.skill: must be inside the plugin folder/);
  refused('id: mesh\nversion: 1.0.0\napiVersion: 1\nkinds: [tool]\ndescription: x\nagent: {}\n', true, /agent: needs at least one of mcp, skill or cli/);
});

test('discovery: built-in, then project folders; a project plugin replaces a built-in one of the same id only when listed under replace; a broken one is a problem, not a failure', () => {
  const builtin = temp(), own = temp();
  plugin(builtin, 'mesh', manifest('mesh'));
  plugin(builtin, 'sound', manifest('sound'));
  plugin(own, 'mesh', manifest('mesh').replace('version: 1.0.0', 'version: 2.0.0'));
  plugin(own, 'broken', 'id: broken\n');
  const found = discoverPlugins([{ path: own }], builtin, ['mesh']);
  assert.deepEqual(found.tools.map(t => [t.manifest.id, t.manifest.version, t.origin]), [['mesh', '2.0.0', 'project'], ['sound', '1.0.0', 'built-in']]);
  assert.equal(found.problems.length, 1); assert.match(found.problems[0]!, /broken\/alba-plugin\.yaml: apiVersion/);
  // Without replace, the built-in one stays and the project's copy is refused by name.
  const kept = discoverPlugins([{ path: own }], builtin);
  assert.deepEqual(kept.tools.map(t => [t.manifest.id, t.manifest.version, t.origin]), [['mesh', '1.0.0', 'built-in'], ['sound', '1.0.0', 'built-in']]);
  assert.deepEqual(kept.refused.map(x => x.id), ['mesh']);
  assert.match(kept.refused[0]!.problem, /id: "mesh" is the id of a built-in plugin .*list "mesh" under plugins\.replace/);
  // The example that ships with Alba is valid.
  assert.ok(discoverPlugins([]).tools.some(t => t.manifest.id === 'example-echo' && t.origin === 'built-in'));
  assert.equal(discoverPlugins([]).problems.length, 0, discoverPlugins([]).problems.join('\n'));
  assert.equal(slash(BUILTIN_PLUGINS).endsWith('/plugins'), true);
});

test('project config: enable loads the tools, by_kind names enabled tools only, git sources wait, and tool resources join the project\'s', async () => {
  const { validateProject } = await import('./state-helper.ts');
  const dir = temp(), own = path.join(dir, 'tools');
  mkdirSync(path.join(dir, 'wo'));
  plugin(own, 'mesh', manifest('mesh', 'resources: { mesh-wallet: { slots: 2 }, gpu: { slots: 9 } }\n'));
  const base = { id: 'p', name: 'P', root: dir, work_orders: path.join(dir, 'wo'), state_dir: path.join(dir, 'state') };
  const cfg = validateProject({ ...base, resources: { gpu: { slots: 1 } }, plugins: { enable: ['mesh'], sources: [{ path: 'tools' }], by_kind: { model: ['mesh'] } } }, path.join(dir, 'alba.yaml'));
  assert.deepEqual(Object.keys(cfg.plugins!.tools), ['mesh']);
  assert.equal(cfg.resources!['mesh-wallet']!.slots, 2);
  assert.equal(cfg.resources!.gpu!.slots, 1, 'a resource the project declares wins');
  const bad = (plugins: unknown, pattern: RegExp) => assert.throws(() => validateProject({ ...base, plugins }, path.join(dir, 'alba.yaml')), pattern);
  bad({ enable: ['nope'] }, /plugins\.enable": no plugin "nope" \(found: audio-studio, example-echo, image-gateway, tripo-3d\)/);
  bad({ enable: ['mesh'], sources: [{ path: 'tools' }], by_kind: { model: ['example-echo'] } }, /plugins\.by_kind\.model": "example-echo" is not in plugins\.enable/);
  bad({ sources: [{ git: 'https://example.com/x.git' }] }, /git and npm sources are not supported yet/);
  bad({ enable: ['mesh'], extra: 1 }, /unknown key\(s\) under "plugins": extra/);
  // Without a plugins block nothing is read and nothing changes.
  assert.equal(validateProject(base, path.join(dir, 'alba.yaml')).plugins, undefined);
});

test('project config: the manifest id is the identity; a project plugin in another folder with a built-in id replaces it only through plugins.replace', async () => {
  const { validateProject } = await import('./state-helper.ts');
  const dir = temp(), own = path.join(dir, 'tools');
  mkdirSync(path.join(dir, 'wo'));
  // Folder "my-echo", id "example-echo": the id of a plugin that ships with Alba.
  const copy = path.join(own, 'my-echo');
  mkdirSync(path.join(copy, 'skills', 'example-echo'), { recursive: true });
  writeFileSync(path.join(copy, 'skills', 'example-echo', 'SKILL.md'), '---\nname: example-echo\ndescription: The copy.\n---\n\nUse it.\n');
  writeFileSync(path.join(copy, 'alba-plugin.yaml'), manifest('example-echo').replace('version: 1.0.0', 'version: 9.0.0'));
  const base = { id: 'p', name: 'P', root: dir, work_orders: path.join(dir, 'wo'), state_dir: path.join(dir, 'state') };
  const file = path.join(dir, 'alba.yaml');
  const found = discoverPlugins([{ path: own }]);
  assert.ok(found.problems.some(p => /my-echo\/alba-plugin\.yaml: id: "example-echo" differs from its folder name "my-echo"/.test(p)), found.problems.join('\n'));
  assert.equal(found.tools.find(t => t.manifest.id === 'example-echo')!.origin, 'built-in');
  // Enabling the id with a refused copy fails with the reason; listing it under replace uses the project's copy.
  assert.throws(() => validateProject({ ...base, plugins: { enable: ['example-echo'], sources: [{ path: 'tools' }] } }, file), /plugins\.enable": .*id: "example-echo" is the id of a built-in plugin.*plugins\.replace/);
  const replaced = validateProject({ ...base, plugins: { enable: ['example-echo'], sources: [{ path: 'tools' }], replace: ['example-echo'] } }, file);
  assert.equal(replaced.plugins!.tools['example-echo']!.origin, 'project');
  assert.equal(replaced.plugins!.tools['example-echo']!.manifest.version, '9.0.0');
  assert.throws(() => validateProject({ ...base, plugins: { sources: [{ path: 'tools' }], replace: ['mesh'] } }, file), /plugins\.replace": "mesh" is not a built-in plugin/);
  assert.throws(() => validateProject({ ...base, plugins: { replace: ['image-gateway'] } }, file), /plugins\.replace": no plugin with the id "image-gateway" in plugins\.sources/);
});

test('order tools: named on the order or by kind; a tool that is not enabled is a problem; servers join the role mount with their tool lists', async () => {
  const { validateProject } = await import('./state-helper.ts');
  const dir = temp(), own = path.join(dir, 'tools');
  mkdirSync(path.join(dir, 'wo'));
  plugin(own, 'mesh', manifest('mesh', 'resources: { mesh-wallet: { slots: 1 } }\n'));
  const cfg = validateProject({ id: 'p', name: 'P', root: dir, work_orders: path.join(dir, 'wo'), state_dir: path.join(dir, 'state'), plugins: { enable: ['mesh', 'example-echo'], sources: [{ path: 'tools' }], by_kind: { model: ['mesh'] } } }, path.join(dir, 'alba.yaml'));
  const doc = (kind: string, tools?: string[]) => ({ order: { tag: 'M1', title: 'Model', kind, needs: [], ...(tools ? { tools } : {}), created: '', updated: '' }, runs: [], actions: [] }) as unknown as OrderDoc;
  assert.deepEqual(orderTools(cfg, doc('model')).tools.map(t => t.manifest.id), ['mesh']);
  assert.deepEqual(orderTools(cfg, doc('code', ['example-echo', 'mesh'])).tools.map(t => t.manifest.id), ['example-echo', 'mesh']);
  assert.match(orderTools(cfg, doc('code', ['missing'])).problems[0]!, /the tool "missing", which is not enabled/);
  const { usesOf } = await import('../src/resources/leases.ts');
  assert.deepEqual(usesOf(cfg, doc('model')), ['mesh-wallet']);
  assert.deepEqual(usesOf(cfg, doc('code')), []);

  const tools = orderTools(cfg, doc('model', ['example-echo'])).tools;
  const role = withToolServers({ id: 'art', source: 'kind', definition: { sources: {}, mcp: { query: { command: 'q', args: [] } } } }, tools);
  assert.deepEqual(Object.keys(role.definition!.mcp!), ['query', 'echo', 'mesh']);
  assert.throws(() => withToolServers({ id: 'art', source: 'kind', definition: { sources: {}, mcp: { mesh: { command: 'q', args: [] } } } }, tools), /MCP server name "mesh" is already used/);
  assert.throws(() => checkToolEnvironment(tools, 'codex-cli', {}), /tool mesh: agent\.mcp\.mesh needs the environment variable MESH_KEY, which is not set/);
  checkToolEnvironment(tools, 'codex-cli', { MESH_KEY: 'x' });

  const cwd = temp();
  const codex = mountRole(cwd, 'codex-cli', role, { MESH_KEY: 'value-not-in-argv' });
  assert.ok(codex.args.includes('mcp_servers.mesh.enabled_tools=["quote","make"]'), codex.args.join(' '));
  assert.ok(codex.args.includes('mcp_servers.echo.enabled_tools=["echo"]'));
  assert.ok(!codex.args.some(a => a.includes('value-not-in-argv')));
  const claude = mountRole(cwd, 'claude-cli', role, { MESH_KEY: 'value-not-in-argv' });
  assert.equal(claude.args.at(-1), 'mcp__query__*,mcp__echo__echo,mcp__mesh__quote,mcp__mesh__make');
  const opencode = mountRole(temp(), 'opencode', role, { MESH_KEY: 'x' });
  assert.ok(opencode.warnings.some(w => /mcp\.mesh: OpenCode gets all of the server's tools/.test(w)));

  const prompt = toolsPrompt(tools, 'codex-cli', codex.servers);
  assert.match(prompt, /## Tools of this run/);
  assert.match(prompt, /- \*\*mesh\*\*: The mesh tool\. MCP server `mesh` \(tools: quote, make\); its skill `mesh` says how to use it\. A run holds mesh-wallet while it uses it\./);
  assert.match(toolsPrompt(tools, 'grok-cli', []), /MCP server `mesh` is not available to this engine/);
  assert.equal(toolsPrompt([], 'codex-cli', []), '');
});

test('launch: an order with a tool gets its server, its skill and the Tools section; the run records id@version', async () => {
  const { tempOrders } = await import('./helpers.ts');
  const { validateProject } = await import('./state-helper.ts');
  const { startRun } = await import('../src/run/launch.ts');
  const { dir, orders } = tempOrders(), root = path.join(dir, 'repo'), orderDir = path.join(dir, 'orders');
  mkdirSync(root); mkdirSync(orderDir);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'Initial']);
  writeFileSync(path.join(orderDir, 'E1-echo.md'), '# Echo');
  const cfg = validateProject({ id: 'demo', name: 'Demo', root, work_orders: orderDir, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' }, roles: { default: {} }, plugins: { enable: ['example-echo'] } }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'fake', engine: 'codex-cli', launch: { program: 'fake-engine', args: ['exec', '{prompt_file}'] } }] }, path.join(dir, 'workers.yaml'));
  let argv: string[] = [];
  const probes = { now: () => new Date(), spawnDetached: (_p: string, args: string[]) => { argv = args; return 123; }, processStartedAt: () => undefined } as unknown as import('../src/tick/gather.ts').Probes;
  orders.add({ tag: 'E1', title: 'Echo', kind: 'code', tools: ['example-echo'] }); orders.act('E1', 'queue');
  startRun({ project: cfg, orders, workers, probes }, 'E1', 'fake');
  const run = orders.get('E1').runs[0]!;
  assert.deepEqual(run.tools, ['example-echo@1.0.0']);
  assert.deepEqual(run.mcp_servers, ['echo']);
  assert.ok(argv.includes('mcp_servers.echo.enabled_tools=["echo"]'), argv.join(' '));
  const prompt = readFileSync(run.prompt_file!, 'utf8');
  assert.match(prompt, /## Tools of this run\n\n- \*\*example-echo\*\*: Repeats the text it is given/);
  assert.match(prompt, /example-echo\/SKILL\.md/, 'the tool\'s skill is listed with the order\'s skills');
  assert.ok(run.skills?.includes('example-echo'));
  // A tool that is no longer enabled stops the start with the reason, before anything is launched.
  orders.runEnd('E1'); orders.act('E1', 'queue', { force: true });
  cfg.plugins = { ...cfg.plugins!, tools: {} };
  assert.throws(() => startRun({ project: cfg, orders, workers, probes }, 'E1', 'fake'), /E1 cannot start now: the order uses the tool "example-echo", which is not enabled/);
});

test('doctor: the example tool\'s probe runs and its MCP server lists the tools the manifest names; a missing secret is named, never shown', async () => {
  const echo = discoverPlugins([]).tools.find(t => t.manifest.id === 'example-echo')!;
  const ok = await doctorTool(echo);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.checks.map(c => c.name), ['probe', 'mcp echo']);
  const asking = { ...echo, manifest: { ...echo.manifest, agent: { ...echo.manifest.agent, mcp: { echo: { ...echo.manifest.agent.mcp.echo!, env_from: ['ECHO_TOKEN'], tools: ['echo', 'shout'] } } } } };
  const missing = await doctorTool(asking, {});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.checks.find(c => c.name === 'environment'), { name: 'environment', ok: false, detail: 'not set: ECHO_TOKEN' });
  const absent = await doctorTool(asking, { ECHO_TOKEN: 'sensitive-value' });
  assert.match(absent.checks.find(c => c.name === 'mcp echo')!.detail, /does not offer: shout/);
  assert.ok(!JSON.stringify(absent).includes('sensitive-value'));
});
