import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validateProject } from '../src/config.ts';
import { effectiveRoles, resolveRole, validateRoles, validateRouting } from '../src/roles/config.ts';
import { migrateRoles } from '../src/roles/migrate.ts';
import { rolesView } from '../src/roles/view.ts';
import { chooseWorker, rolePolicy, type Choosable } from '../src/routing/choose.ts';
import { validateWorkers } from '../src/workers/config.ts';

const workersFile = (extra: Record<string, unknown> = {}) => validateWorkers({
  workers: [
    { id: 'codex', engine: 'codex-cli', capabilities: ['shell', 'edit', 'git'] },
    { id: 'claude-sonnet', engine: 'claude-cli', capabilities: ['shell', 'edit', 'git'], aliases: ['sonnet'] },
    { id: 'grok', engine: 'grok-cli', capabilities: ['shell', 'edit'] },
    { id: 'opencode', engine: 'opencode', capabilities: ['shell', 'edit', 'git'] },
  ],
  ...extra,
}, 'workers.yaml');
const states = (file: ReturnType<typeof workersFile>, over: Record<string, Partial<Choosable>> = {}): Choosable[] =>
  file.workers.map(config => ({ config, available: true, reasons: [], running: 0, runsToday: 0, ...over[config.id] }));
const routing = {
  groups: { main: ['codex', 'sonnet'], cheap: ['grok', 'opencode'], all: ['main', 'cheap'] },
  default: 'main',
  routes: {
    ue: { kinds: ['ue', 'build'], group: 'main', requires: ['git'] },
    art: { kinds: ['art'], group: 'cheap', avoid: ['grok'] },
    docs: { kinds: ['docs'], group: 'all' },
  },
};

test('a route draws on its worker group: the group\'s order is the preference and nobody outside it is chosen', () => {
  const file = workersFile({ routing });
  const roles = effectiveRoles({}, file);
  assert.deepEqual(roles.ue.workers, { prefer: ['codex', 'sonnet'], only: ['codex', 'sonnet'] });
  assert.equal(roles.ue.group, 'main');
  // Nested groups expand in place.
  assert.deepEqual(roles.docs.workers?.only, ['codex', 'sonnet', 'grok', 'opencode']);
  // routing.default makes the default route of the orders no route takes.
  const fallback = resolveRole(roles, { kind: 'misc' });
  assert.equal(fallback.source, 'default');
  assert.equal(fallback.definition?.group, 'main');

  const ue = rolePolicy(resolveRole(roles, { kind: 'build' }))!;
  const first = chooseWorker({ kind: 'build', tags: [], role: ue }, states(file));
  assert.equal(first.chosen, 'codex');
  assert.match(first.why, /group main #1/);
  assert.equal(first.candidates.find(c => c.worker === 'opencode')?.reason, 'not in worker group main');
  // The next one in the group takes over when the first is busy or out of quota; workers outside the group do not.
  const busy = chooseWorker({ kind: 'build', tags: [], role: ue }, states(file, { codex: { available: false, reasons: ['quota: window "5h" at 100%'] } }));
  assert.equal(busy.chosen, 'claude-sonnet');
  const none = chooseWorker({ kind: 'build', tags: [], role: ue }, states(file, { codex: { running: 1, config: { ...file.workers[0], concurrency: 1 } }, 'claude-sonnet': { available: false, reasons: ['off'] } }));
  assert.equal(none.outcome, 'none-available');

  // avoid still applies inside a group.
  const art = chooseWorker({ kind: 'art', tags: [], role: rolePolicy(resolveRole(roles, { kind: 'art' }))! }, states(file));
  assert.equal(art.chosen, 'opencode');
  assert.equal(art.candidates.find(c => c.worker === 'grok')?.reason, 'avoided by role');
});

test('one edit to a group reaches every route that uses it', () => {
  const before = effectiveRoles({}, workersFile({ routing }));
  const after = effectiveRoles({}, workersFile({ routing: { ...routing, groups: { ...routing.groups, main: ['sonnet', 'codex'] } } }));
  assert.deepEqual(before.ue.workers?.prefer, ['codex', 'sonnet']);
  assert.deepEqual(after.ue.workers?.prefer, ['sonnet', 'codex']);
  assert.deepEqual(after.default.workers?.prefer, ['sonnet', 'codex']);
  assert.deepEqual(after.docs.workers?.prefer?.slice(0, 2), ['sonnet', 'codex']);
});

test('the project file can redefine a group or a route of the workers file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-routing-'));
  const file = workersFile({ routing });
  const project = validateProject({ id: 'p', name: 'P', root: dir, work_orders: dir, state_dir: dir, routing: { groups: { main: ['opencode'] }, routes: { art: { kinds: ['art'], workers: { prefer: ['codex'] } } } } }, path.join(dir, 'alba.yaml'));
  assert.equal(project.uses_routing, true);
  const roles = effectiveRoles(project, file);
  assert.deepEqual(roles.ue.workers?.only, ['opencode']);
  // A project route with its own worker list drops the shared route's group (and keeps its avoid list).
  assert.equal(roles.art.group, undefined);
  assert.deepEqual(roles.art.workers, { avoid: ['grok'], prefer: ['codex'] });
});

test('routing is validated with the key that is wrong, and says where a moved key belongs', () => {
  const bad = (r: unknown) => () => validateRouting(r, 'alba.yaml');
  assert.throws(bad({ routes: { art: { kinds: ['art'], skills: ['drawing'] } } }), /alba\.yaml: routing\.routes\.art\.skills: .*skills\.by_kind/);
  assert.throws(bad({ routes: { art: { mcp: {} } } }), /routing\.routes\.art\.mcp: .*tool plugins/);
  assert.throws(bad({ routes: { art: { rules: 'a.md' } } }), /routing\.routes\.art\.rules: .*skill/);
  assert.throws(bad({ routes: { art: { group: 'main', workers: { only: ['codex'] } } } }), /a group already orders and limits the workers/);
  assert.throws(bad({ routes: { art: { kinds: 'art' } } }), /routing\.routes\.art\.kinds: must be a list/);
  assert.throws(bad({ groups: { main: [] } }), /routing\.groups\.main: must be a non-empty list/);
  assert.throws(bad({ default: 'main', routes: { base: { default: true } } }), /route base is already the default/);
  assert.throws(bad({ ruotes: {} }), /routing\.ruotes: unknown key/);
  assert.throws(() => effectiveRoles({}, workersFile({ routing: { routes: { ue: { group: 'nope' } } } })), /route ue: there is no worker group "nope"/);
  assert.throws(() => effectiveRoles({}, workersFile({ routing: { groups: { a: ['b'], b: ['a'] }, routes: { ue: { group: 'a' } } } })), /contains itself \(a -> b -> a\)/);
  assert.throws(() => effectiveRoles({}, workersFile({ routing: { groups: { main: ['codx'] }, routes: { ue: { group: 'main' } } } })), /"codx" is not a worker id, alias or model family/);
  assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'x' }], roles: {}, routing: {} }, 'workers.yaml'), /"roles" and "routing" are both set/);
});

test('earlier roles keep working, and migrate turns them into routes and groups with notes on what moved', () => {
  const roles = validateRoles({
    builder: { kinds: ['ue'], requires: ['git'], workers: { prefer: ['codex', 'claude-sonnet'], only: ['claude-sonnet', 'codex'] }, skills: ['unreal'], effort: 'high' },
    tester: { kinds: ['test'], workers: { prefer: ['codex', 'claude-sonnet'], only: ['codex', 'claude-sonnet'] } },
    art: { kinds: ['art'], workers: { prefer: ['grok'], avoid: ['codex'] }, mcp: { image: { command: 'img', args: [] } } },
    default: { workers: { only: ['opencode'] } },
  }, 'workers.yaml');
  const file = workersFile({ roles: Object.fromEntries(Object.entries(roles).map(([id, r]) => { const { sources: _s, ...rest } = r; return [id, rest]; })) });
  assert.equal(chooseWorker({ kind: 'ue', tags: [], role: rolePolicy(resolveRole(effectiveRoles({}, file), { kind: 'ue' }))! }, states(file)).chosen, 'codex');

  const m = migrateRoles(roles);
  const out = parse(m.yaml).routing;
  assert.deepEqual(out.groups, { builder: ['codex', 'claude-sonnet'], art: ['grok', '*'], default: ['opencode'] });
  assert.equal(out.routes.builder.group, 'builder');
  assert.equal(out.routes.tester.group, 'builder', 'roles with the same workers share one group');
  assert.deepEqual(out.routes.art, { kinds: ['art'], group: 'art', avoid: ['codex'] }, 'a role that only preferred becomes a group ending in "*"');
  assert.ok(m.notes.some(n => /builder: skills unreal -> skills\.by_kind\.ue/.test(n)));
  assert.ok(m.notes.some(n => /art: MCP server image -> a tool plugin/.test(n)));
  assert.ok(m.notes.some(n => /builder: effort\/reasoning high/.test(n)));
  // What migrate prints is valid routing that routes the same way.
  const migrated = effectiveRoles({}, workersFile({ routing: out }));
  for (const kind of ['ue', 'test', 'art', 'misc']) {
    const a = chooseWorker({ kind, tags: [], role: rolePolicy(resolveRole(effectiveRoles({}, file), { kind }))! }, states(file));
    const b = chooseWorker({ kind, tags: [], role: rolePolicy(resolveRole(migrated, { kind }))! }, states(file));
    assert.equal(b.chosen, a.chosen, kind);
  }
});

test('the routing view lists each group with its workers in order and the routes that draw on it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-routing-'));
  const project = validateProject({ id: 'p', name: 'P', root: dir, work_orders: dir, state_dir: dir }, path.join(dir, 'alba.yaml'));
  const file = workersFile({ routing });
  const view = rolesView(project, file, [], [], states(file));
  assert.deepEqual(view.groups.find(g => g.name === 'all'), { name: 'all', list: ['main', 'cheap'], members: ['codex', 'sonnet', 'grok', 'opencode'], routes: ['docs'], source: 'workers' });
  assert.deepEqual(view.groups.find(g => g.name === 'main')?.routes, ['ue', 'default']);
  assert.deepEqual(view.roles.find(r => r.id === 'ue')?.qualifying, ['codex', 'claude-sonnet']);
});

test('"*" in a group lets anyone else take the work after the listed workers, and routing.avoid is written once for every route', () => {
  const file = workersFile({ routing: { groups: { first: ['sonnet', '*'] }, avoid: ['grok'], routes: { docs: { kinds: ['docs'], group: 'first' }, ue: { kinds: ['ue'] } } } });
  const roles = effectiveRoles({}, file);
  assert.deepEqual(roles.docs.workers, { prefer: ['sonnet'], avoid: ['grok'] }, 'no only: anyone else may follow');
  assert.deepEqual(roles.ue.workers, { avoid: ['grok'] });
  const docs = rolePolicy(resolveRole(roles, { kind: 'docs' }))!;
  assert.equal(chooseWorker({ kind: 'docs', tags: [], role: docs }, states(file)).chosen, 'claude-sonnet');
  const fallback = chooseWorker({ kind: 'docs', tags: [], role: docs }, states(file, { 'claude-sonnet': { available: false, reasons: ['off'] } }));
  assert.equal(fallback.chosen, 'codex');
  assert.equal(fallback.candidates.find(c => c.worker === 'grok')?.reason, 'avoided by role');
  // A shared avoid list alone still lets every order go to the other workers.
  const only = effectiveRoles({}, workersFile({ routing: { avoid: ['grok'] } }));
  assert.equal(resolveRole(only, { kind: 'x' }).source, 'default');
  assert.throws(() => effectiveRoles({}, workersFile({ routing: { avoid: ['grk'] } })), /routing\.avoid: "grk" is not a worker/);
  assert.throws(() => validateRouting({ avoid: ['*'] }, 'a.yaml'), /routing\.avoid: lists workers/);
});

test('migrate writes a never-used worker once under routing.avoid when every route that could reach it avoided it', () => {
  const never = ['claude-opus'];
  const roles = validateRoles({
    builder: { default: true, workers: { prefer: ['codex', 'sonnet'], avoid: never } },
    ue: { kinds: ['ue'], workers: { prefer: ['codex'], avoid: [...never, 'grok'] } },
    light: { kinds: ['light'], workers: { only: ['sonnet'] } },
  }, 'alba.yaml');
  const out = parse(migrateRoles(roles).yaml).routing;
  assert.deepEqual(out.avoid, ['claude-opus']);
  assert.deepEqual(out.routes.ue.avoid, ['grok']);
  assert.equal(out.routes.builder.avoid, undefined);
  // One route did not avoid it: it stays on the routes that did.
  const mixed = parse(migrateRoles(validateRoles({ a: { kinds: ['a'], workers: { prefer: ['codex'], avoid: never } }, b: { kinds: ['b'], workers: { prefer: ['codex'] } } }, 'alba.yaml')).yaml).routing;
  assert.equal(mixed.avoid, undefined);
  assert.deepEqual(mixed.routes.a.avoid, never);
});
