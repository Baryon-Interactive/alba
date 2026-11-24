import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { effectiveRoles, resolveRole, validateRoles } from '../src/roles/config.ts';
import { mountRole, roleRules, withRoleRules } from '../src/roles/mount.ts';
import { chooseWorker } from '../src/routing/choose.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { buildPrompt, launchArgs } from '../src/run/prompt.ts';

const temp = () => mkdtempSync(path.join(tmpdir(), 'alba-roles-'));
const art = { description: 'Artwork', kinds: ['art'], skills: ['drawing'], mcp: { image: { command: 'image-tool', args: ['--stdio'], env_from: ['IMAGE_TOKEN'] } }, rules: 'art.md', workers: { prefer: ['painter'], avoid: ['slow'] } };

test('roles merge keys, preserve source-relative rules and stable first-match resolution', () => {
  const shared = { roles: validateRoles({ art, designer: { kinds: ['art', 'design'] } }, 'shared/workers.yaml') };
  const project = { roles: validateRoles({ art: { description: 'Project artwork', workers: { prefer: ['fast'] } }, programmer: { kinds: ['code'] } }, 'project/alba.yaml') };
  const roles = effectiveRoles(project, shared);
  assert.deepEqual(Object.keys(roles), ['art', 'designer', 'programmer']);
  assert.equal(roles.art.description, 'Project artwork');
  assert.deepEqual(roles.art.workers, { prefer: ['fast'], avoid: ['slow'] });
  assert.equal(roles.art.rules, path.resolve('shared/art.md'));
  assert.equal(roles.art.sources.description, 'project/alba.yaml');
  assert.equal(roles.art.sources.rules, 'shared/workers.yaml');
  assert.equal(resolveRole(roles, { kind: 'art' }).id, 'art');
  assert.equal(resolveRole(roles, { role: 'designer', kind: 'art' }).source, 'explicit');
  assert.equal(resolveRole(roles, { role: 'designer', kind: 'art' }).id, 'designer');
  assert.deepEqual(resolveRole(roles, { kind: 'unknown' }), { source: 'none' });
  assert.throws(() => resolveRole(roles, { role: 'missing', kind: 'art' }), /Unknown role/);
});

test('both config loaders validate roles; errors identify file/key and never echo secret values', () => {
  const dir = temp();
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: dir, roles: { art } }, path.join(dir, 'alba.yaml'));
  assert.deepEqual(project.roles?.art.skills, ['drawing']);
  assert.equal(validateWorkers({ workers: [{ id: 'w', engine: 'codex-cli' }], roles: { art } }, 'workers.yaml').roles?.art.description, 'Artwork');
  for (const bad of [{ mcp: { image: { command: 'x', args: [], env: { API_KEY: 'sensitive-value' } } } }, { mcp: { image: { command: 'x', args: [], env_from: ['TOKEN=sensitive-value'] } } }, { token: 'sensitive-value' }, { workers: { unknown: [] } }, { skills: 'oops' }]) {
    assert.throws(() => validateRoles({ art: bad }, 'bad.yaml'), e => { assert.match(String(e), /bad.yaml: roles.art/); assert.ok(!String(e).includes('sensitive-value')); return true; });
  }
});

test('role prefer precedes yield and cost; avoid aliases drop; explicit id still wins subject to limits', () => {
  const configs = validateWorkers({ workers: [
    { id: 'cheap', engine: 'x', cost: 'included' },
    { id: 'painter', aliases: ['Artist'], engine: 'x', cost: 'paid' },
    { id: 'best', engine: 'x', cost: 'paid' },
  ] }, 'w.yaml').workers;
  const states = configs.map(config => ({ config, available: true, reasons: [], running: 0, runsToday: 0 }));
  const input = { kind: 'art', tags: [], role: { prefer: ['Artist'], avoid: ['best'] } };
  assert.equal(chooseWorker(input, states).chosen, 'painter');
  assert.match(chooseWorker(input, states).candidates.find(c => c.worker === 'best')!.reason, /avoided by role/);
  assert.equal(chooseWorker({ ...input, role: { prefer: ['Artist'] } }, states).chosen, 'painter');
  assert.equal(chooseWorker({ ...input, workerText: 'best' }, states).chosen, 'best');
  states[2].running = 1;
  assert.equal(chooseWorker({ ...input, workerText: 'best' }, states).outcome, 'none-available');
  states[1].available = false;
  assert.equal(chooseWorker(input, states).chosen, 'cheap');
});

test('engine adapters generate config/argv with names only; unsupported/filter cases and no-role are empty', () => {
  const role = resolveRole(validateRoles({ art }, 'workers.yaml'), { kind: 'art' });
  for (const engine of ['claude-cli', 'codex-cli', 'opencode']) {
    const cwd = temp();
    execFileSync('git', ['init', '-q', cwd]);
    const mount = mountRole(cwd, engine, role, { IMAGE_TOKEN: 'sensitive-value' });
    assert.deepEqual(mount.servers, ['image']);
    assert.deepEqual(mount.env, { IMAGE_TOKEN: 'sensitive-value' });
    assert.ok(!JSON.stringify(mount.args).includes('sensitive-value'));
    if (engine === 'codex-cli') assert.deepEqual(mount.args, ['-c', 'mcp_servers.image.command="image-tool"', '-c', 'mcp_servers.image.args=["--stdio"]', '-c', 'mcp_servers.image.env_vars=["IMAGE_TOKEN"]']);
    else if (engine === 'claude-cli') {
      assert.deepEqual(mount.args, ['--mcp-config', path.join(cwd, '.alba/role-mcp.json'), '--allowedTools', 'mcp__image__*']);
      assert.deepEqual(JSON.parse(readFileSync(mount.args[1], 'utf8')), { mcpServers: { image: { command: 'image-tool', args: ['--stdio'], env: { IMAGE_TOKEN: '${IMAGE_TOKEN}' } } } });
    } else {
      assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, '.opencode/opencode.json'), 'utf8')), { $schema: 'https://opencode.ai/config.json', mcp: { servers: { image: { type: 'local', command: ['image-tool', '--stdio'], environment: { IMAGE_TOKEN: '{env:IMAGE_TOKEN}' } } } } });
      assert.equal(execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }), '');
      mountRole(cwd, engine, { source: 'none' });
      assert.equal(existsSync(path.join(cwd, '.opencode/opencode.json')), false);
    }
  }
  const cwd = temp();
  assert.match(mountRole(cwd, 'grok-cli', role).warnings[0], /role art: MCP servers not mounted for engine grok-cli/);
  role.definition!.mcp!.image.engines = ['claude-cli'];
  assert.deepEqual(mountRole(cwd, 'codex-cli', role), { args: [], env: {}, servers: [], warnings: [] });
  assert.deepEqual(mountRole(cwd, 'codex-cli', { source: 'none' }), { args: [], env: {}, servers: [], warnings: [] });
});

test('rules are read on each launch and precede work order; absent role preserves exact prompt/argv bytes', () => {
  const dir = temp(), file = path.join(dir, 'rules.md');
  writeFileSync(file, 'Use the review checklist.');
  const role = resolveRole(validateRoles({ art: { rules: 'rules.md' } }, path.join(dir, 'alba.yaml')), { role: 'art', kind: '' });
  assert.equal(roleRules(role), 'Use the review checklist.');
  writeFileSync(file, 'Use the updated checklist.');
  const baseline = buildPrompt({ orderFile: 'order.md', recovery: false });
  assert.equal(withRoleRules(baseline, undefined), baseline);
  const prompt = buildPrompt({ orderFile: 'order.md', recovery: false, roleRules: roleRules(role) });
  assert.equal(prompt, '## Role rules\n\nUse the updated checklist.\n\n' + baseline);
  const template = { args: ['exec', '-m', '{model}', '{prompt}'] }, values = { model: 'fake', prompt: 'Read order.md' };
  const args = launchArgs(template, values, false);
  assert.deepEqual([...mountRole(dir, 'codex-cli', { source: 'none' }).args, ...args], ['exec', '-m', 'fake', 'Read order.md']);
});


test('role skills merge once with project and order skills, obey filters and total cap', async () => {
  const { tempOrders } = await import('./helpers.ts');
  const { readRegistry, selectSkills } = await import('../src/skills/registry.ts');
  const { dir, orders } = tempOrders();
  const lib = path.join(dir, 'skills');
  for (const name of ['always', 'kind', 'role', 'order', 'blocked', 'foreign']) {
    mkdirSync(path.join(lib, name), { recursive: true });
    writeFileSync(path.join(lib, name, 'SKILL.md'), `---
name: ${name}
description: Example
${name === 'foreign' ? 'engines: [unity]\n' : ''}---
# Example
`);
  }
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), skills: { engine: 'godot', always: ['always'], by_kind: { art: ['kind'] }, exclude: ['blocked'], max_per_order: 5 } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'A1', title: 'Art', kind: 'art', skills: ['order', 'role'] });
  const shared = validateWorkers({ workers: [{ id: 'fake', engine: 'x' }], skills: { sources: [{ id: 'lib', dir: lib }] } }, path.join(dir, 'workers.yaml'));
  const registry = readRegistry(shared.skills, cfg);
  const selection = selectSkills(cfg, registry, orders.get('A1'), { kind: 'art', tags: [] }, ['kind', 'role', 'blocked', 'foreign']);
  assert.deepEqual(selection.selected.map(s => s.skill.name), ['alba-worker-rules', 'always', 'kind', 'role', 'order']);
  assert.equal(selection.problems.length, 2);
  cfg.skills!.max_per_order = 3;
  // The cap drops a role's own additions, never a skill the order names (here 'role' and 'order').
  assert.deepEqual(selectSkills(cfg, registry, orders.get('A1'), { kind: 'art', tags: [] }, ['role']).selected.map(s => s.skill.name), ['alba-worker-rules', 'always', 'kind', 'role', 'order']);
  orders.add({ tag: 'A2', title: 'Art', kind: 'art' });
  const capped = selectSkills(cfg, registry, orders.get('A2'), { kind: 'art', tags: [] }, ['role']);
  assert.deepEqual(capped.selected.map(s => s.skill.name), ['alba-worker-rules', 'always', 'kind']);
  assert.equal(capped.truncated, 1);
});

test('a role skill cap never drops the skill a tool plugin needs', async () => {
  const { tempOrders } = await import('./helpers.ts');
  const { readRegistry, selectSkills } = await import('../src/skills/registry.ts');
  const { dir, orders } = tempOrders();
  const lib = path.join(dir, 'skills');
  for (const name of ['r1', 'r2', 'r3', 'tool-skill']) {
    mkdirSync(path.join(lib, name), { recursive: true });
    writeFileSync(path.join(lib, name, 'SKILL.md'), `---
name: ${name}
description: Example
---
# Example
`);
  }
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state'), skills: { engine: 'godot', max_per_order: 3 } }, path.join(dir, 'alba.yaml'));
  orders.add({ tag: 'T1', title: 'Tool', kind: 'art' });
  const shared = validateWorkers({ workers: [{ id: 'fake', engine: 'x' }], skills: { sources: [{ id: 'lib', dir: lib }] } }, path.join(dir, 'workers.yaml'));
  const registry = readRegistry(shared.skills, cfg);
  const selection = selectSkills(cfg, registry, orders.get('T1'), { kind: 'art', tags: [] }, ['r1', 'r2', 'r3'], [{ name: 'tool-skill', tool: 'image' }]);
  // Role additions fill the cap after the tool's skill, which is kept: the last role skills go.
  assert.deepEqual(selection.selected.map(s => s.skill.name), ['alba-worker-rules', 'r1', 'tool-skill']);
  assert.equal(selection.truncated, 2);
});

test('fake launches carry rules, MCP argv and redacted run-start metadata; no-role argv and prompt match legacy', async () => {
  const { tempOrders } = await import('./helpers.ts');
  const { validateProject: projectConfig } = await import('./state-helper.ts');
  const { startRun } = await import('../src/run/launch.ts');
  const { planSkills } = await import('../src/skills/plan.ts');
  const { promptFor } = await import('../src/run/prompt.ts');
  for (const engine of ['claude-cli', 'codex-cli', 'opencode', 'grok-cli']) {
    const { dir, orders } = tempOrders(), root = path.join(dir, 'repo'), orderDir = path.join(dir, 'orders');
    mkdirSync(root); mkdirSync(orderDir);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'Initial']);
    writeFileSync(path.join(orderDir, 'A1-art.md'), '# Artwork');
    writeFileSync(path.join(dir, 'rules.md'), 'Check silhouettes before delivery.');
    const cfg = projectConfig({ id: 'demo', name: 'Demo', root, work_orders: orderDir, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' }, roles: { art: { kinds: ['art'], effort: 'high', reasoning: 'deep', rules: 'rules.md', mcp: { query: { command: 'query-tool', args: [] } } } } }, path.join(dir, 'alba.yaml'));
    const templateArgs = engine === 'codex-cli' ? ['exec', '{prompt_file}'] : engine === 'opencode' ? ['run', '{prompt_file}'] : ['{prompt_file}'];
    const workers = validateWorkers({ workers: [{ id: 'fake', engine, launch: { program: 'fake-engine', args: templateArgs } }] }, path.join(dir, 'workers.yaml'));
    let argv: string[] = [];
    const probes = { now: () => new Date(), spawnDetached: (_p: string, args: string[]) => { argv = args; return 123; }, processStartedAt: () => undefined } as unknown as import('../src/tick/gather.ts').Probes;
    orders.add({ tag: 'A1', title: 'Art', kind: 'art' }); orders.act('A1', 'queue');
    startRun({ project: cfg, orders, workers, probes }, 'A1', 'fake');
    const run = orders.get('A1').runs[0];
    assert.match(readFileSync(run.prompt_file!, 'utf8'), /^## Role rules\n\nCheck silhouettes before delivery\./);
    assert.equal(run.role, 'art'); assert.equal(run.role_source, 'kind');
    assert.equal(run.role_effort, 'high'); assert.equal(run.role_reasoning, 'deep');
    assert.ok(!argv.includes('--effort') && !argv.includes('--reasoning'));
    const event = orders.store.events().find(e => e.type === 'run-start')!;
    assert.deepEqual(event.data?.mcp_servers, engine === 'grok-cli' ? [] : ['query']);
    assert.equal(JSON.stringify(event).includes('env_from'), false);
    if (engine === 'grok-cli') assert.deepEqual(run.role_warnings, ['role art: MCP servers not mounted for engine grok-cli']);
    if (engine === 'codex-cli') assert.deepEqual(argv.slice(0, 6), ['-c', 'mcp_servers.query.command="query-tool"', '-c', 'mcp_servers.query.args=[]', '-c', 'mcp_servers.query.env_vars=[]']);
    if (engine === 'claude-cli') assert.equal(argv[0], '--mcp-config');
    orders.runEnd('A1'); orders.act('A1', 'queue', { force: true });
    cfg.roles = validateRoles({ default: {} }, 'fixture.yaml');
    const doc = orders.get('A1');
    const expectedPrompt = promptFor(orderDir, doc, [], planSkills(cfg, workers, doc, workers.workers[0]).listed);
    startRun({ project: cfg, orders, workers, probes }, 'A1', 'fake');
    const noRole = orders.get('A1').runs[1], pf = noRole.prompt_file!;
    if (engine === 'opencode') {
      assert.ok(readFileSync(pf, 'utf8').startsWith(expectedPrompt));
      assert.ok(readFileSync(pf, 'utf8').includes(`save your final message, ending with the report block, to the file ${noRole.last_file}`));
    } else if (engine === 'claude-cli') {
      assert.ok(readFileSync(pf, 'utf8').startsWith(expectedPrompt));
      assert.match(readFileSync(pf, 'utf8').slice(expectedPrompt.length), /^\nBefore your final message, wait for or stop every background command/);
    } else {
      // The legacy prompt, then where the worker works (its worktree only) and the assigned run slot.
      assert.ok(readFileSync(pf, 'utf8').startsWith(expectedPrompt));
      assert.match(readFileSync(pf, 'utf8').slice(expectedPrompt.length), /^\n## Where you work\n\nYour working folder is .*\n\nThis run holds slot \d+ \(`ALBA_SLOT=\d+`\)\.\n$/);
    }
    const expected = engine === 'codex-cli' ? ['exec', '--json', pf] : engine === 'opencode' ? ['run', '--format', 'json', pf] : engine === 'grok-cli' ? ['--output-format', 'streaming-json', pf] : ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--settings', pf.replace(/\.prompt\.md$/, '.claude-settings.json'), pf];
    assert.deepEqual(argv, expected);
    assert.equal(noRole.role, 'default');
    assert.equal(existsSync(path.join(noRole.cwd!, '.opencode/opencode.json')), false);
  }
});

test('roles API creates, changes and clears explicit roles, and exposes definitions and sources', async () => {
  const { fixture } = await import('./api-fixture.ts');
  const f = await fixture({ populate: false, project: () => ({ roles: { art: { kinds: ['art'], description: 'Artwork' }, designer: { kinds: ['design'] } } }) });
  const view = await f.get('/api/roles');
  assert.equal(view.status, 200); assert.deepEqual(view.body.roles.map((r: { id: string }) => r.id), ['art', 'designer']);
  assert.ok(view.body.roles[0].sources.description.endsWith('alba.yaml'));
  assert.equal((await f.write('/api/orders', { tag: 'A1', title: 'Artwork', kind: 'art', role: 'designer' })).status, 201);
  assert.equal((await f.get('/api/orders/A1')).body.order.role, 'designer');
  assert.equal((await f.get('/api/orders/A1/route')).body.role.source, 'explicit');
  assert.equal((await f.write('/api/orders/A1/role', { role: 'art' })).body.role.id, 'art');
  const cleared = await f.write('/api/orders/A1/role', { role: '' });
  assert.equal(cleared.body.role.id, 'art'); assert.equal(cleared.body.role.source, 'kind');
  assert.equal((await f.write('/api/orders/A1/role', { role: 'missing' })).status, 400);
  assert.equal((await f.post('/api/orders/A1/role', { role: 'art' })).status, 401);
  // The fixture is imported inside this test, so its file-level hooks never run for it; close the board here or the file never exits.
  f.board.hub.stop(); f.board.server.closeAllConnections(); f.board.server.close();
});

test('role statistics keep unknown usage unknown, deduplicate verdicts and expose producer facts', async () => {
  const { roleResults } = await import('../src/roles/statistics.ts');
  const { computeFacts } = await import('../src/producer/facts/engine.ts');
  const { tempOrders } = await import('./helpers.ts');
  const { orders } = tempOrders();
  for (let n = 1; n <= 3; n++) {
    const tag = `A${n}`;
    orders.add({ tag, title: 'Art', kind: 'art' }); orders.act(tag, 'queue');
    const { run } = orders.runStart(tag, { worker: 'painter', extra: { role: 'art', role_source: 'kind' } });
    orders.runEnd(tag);
    orders.patchRun(tag, run.id, { started: '2026-01-01T00:00:00Z', ended: '2026-01-01T01:00:00Z', usage: { source: 'codex-json', total_tokens: n * 100 } });
    orders.act(tag, n === 3 ? 'rework' : 'approve', { force: true });
  }
  const docs = orders.all(), results = roleResults(docs, [], '', '2026-01-02T00:00:00Z');
  assert.equal(results[0].acceptedShare, 2 / 3); assert.equal(results[0].medianTokens, 200); assert.equal(results[0].medianWallHours, 1);
  assert.equal(roleResults(docs.slice(0, 2), [], '', '2026-01-02T00:00:00Z')[0].status, 'not enough runs');
  const facts = computeFacts({ orders: docs, events: [], usage: [], caps: {}, now: '2026-01-02T00:00:00Z' });
  assert.equal(facts.facts.find(f => f.id === 'F:role.art.worker.painter.first_pass_yield.7d')?.value, 2 / 3);
  assert.equal(facts.facts.find(f => f.id === 'F:role.art.worker.painter.tokens_p50.7d')?.value, 200);
  docs[0].runs[0].usage = { source: 'unknown' };
  assert.equal(roleResults(docs, [], '', '2026-01-02T00:00:00Z')[0].medianTokens, null);
});
