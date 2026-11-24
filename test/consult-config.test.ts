import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { chooseConsultant, consultEnabledForOrder } from '../src/consult/choose.ts';
import type { Probes } from '../src/tick/gather.ts';
import { validateWorkers, type WorkerConfig } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

function makeWorker(id: string, family?: string, engine = 'codex-cli', extra: Partial<WorkerConfig> = {}) {
  return {
    id,
    engine,
    ...(family ? { model_family: family } : {}),
    aliases: [],
    launch: { program: id, args: ['exec', '{prompt_file}'], template: 'synthetic' },
    ...extra,
  };
}

function makeFixture(t: TestContext, consultRaw?: unknown, rolesRaw?: Record<string, unknown>, workerDefs?: Record<string, unknown>[]) {
  const { orders, dir } = tempOrders();
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const baseRaw = {
    id: 'demo',
    name: 'Demo',
    root,
    work_orders: workOrders,
    state_dir: path.join(dir, 'state'),
    ...(rolesRaw ? { roles: rolesRaw } : {}),
    ...(consultRaw !== undefined ? { consult: consultRaw } : {}),
  };
  const project = validateProject(baseRaw, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({
    workers: workerDefs ?? [
      makeWorker('gpt-worker', 'gpt', 'codex-cli'),
      makeWorker('gpt-other', 'GPT', 'codex-cli'),
      makeWorker('claude-advisor', 'claude', 'claude-cli'),
      makeWorker('claude-verifier', 'claude', 'claude-cli'),
    ],
  }, path.join(dir, 'workers.yaml'));

  const probes: Probes = {
    now: () => new Date('2026-06-15T10:00:00Z'),
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    fileTime: () => undefined,
    isAlive: () => false,
    tail: () => '',
    readText: () => undefined,
    spawnDetached: () => 1001,
  };
  return { project, orders, workers, probes, dir, root, workOrders };
}

test('consult config validation: defaults, valid overrides, bad values, unknown keys, and schema coverage', t => {
  const f = makeFixture(t, {});
  assert.deepEqual(f.project.consult, {
    enabled: false,
    role: 'consultant',
    max_per_run: 3,
    timeout_minutes: 10,
  });

  const configured = validateProject({
    id: 'demo', name: 'Demo', root: f.root, work_orders: f.workOrders, state_dir: path.join(f.dir, 'state'),
    consult: { enabled: true, role: 'advisor', max_per_run: 5, timeout_minutes: 20, kinds: ['code', 'ue', 'code'] },
  }, path.join(f.dir, 'alba.yaml'));
  assert.deepEqual(configured.consult, {
    enabled: true,
    role: 'advisor',
    max_per_run: 5,
    timeout_minutes: 20,
    kinds: ['code', 'ue'],
  });

  f.orders.add({ tag: 'C1', title: 'Code order', kind: 'code' });
  f.orders.add({ tag: 'D1', title: 'Docs order', kind: 'docs' });
  assert.equal(consultEnabledForOrder(f.project, f.orders.get('C1')), false);
  assert.equal(consultEnabledForOrder(configured, f.orders.get('C1')), true);
  assert.equal(consultEnabledForOrder(configured, f.orders.get('D1')), false);

  const badCases: [unknown, RegExp][] = [
    ['yes', /"consult" must be a mapping/],
    [{ extra_key: true }, /unknown key\(s\) under "consult": extra_key/],
    [{ enabled: 'true' }, /"consult\.enabled" must be true or false/],
    [{ role: 'bad role!' }, /"consult\.role" must be a role name/],
    [{ max_per_run: 0 }, /"consult\.max_per_run" must be a whole number >= 1/],
    [{ max_per_run: 2.5 }, /"consult\.max_per_run" must be a whole number >= 1/],
    [{ timeout_minutes: 0 }, /"consult\.timeout_minutes" must be a positive number <= 30/],
    [{ timeout_minutes: 31 }, /"consult\.timeout_minutes" must be a positive number <= 30/],
    [{ kinds: [] }, /"consult\.kinds" must be a non-empty list of kinds/],
    [{ kinds: [''] }, /"consult\.kinds" must be a non-empty list of kinds/],
  ];
  for (const [bad, pattern] of badCases) {
    assert.throws(() => validateProject({
      id: 'demo', name: 'Demo', root: f.root, work_orders: f.workOrders, state_dir: path.join(f.dir, 'state'),
      consult: bad,
    }, path.join(f.dir, 'alba.yaml')), pattern);
  }

  const schema = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../schema/project.schema.json'), 'utf8'));
  assert.equal(schema.properties.consult.additionalProperties, false);
  assert.equal(schema.properties.consult.properties.timeout_minutes.maximum, 30);
});

test('chooseConsultant enforces cross-family, refuses same worker or missing family, uses role/verifier fallback, and skips disabled or unsupported engines', t => {
  // 1. Running worker without model_family is refused with a clear reason
  const noFam = makeFixture(t, { enabled: true }, undefined, [
    makeWorker('plain-worker', undefined, 'codex-cli'),
    makeWorker('claude-advisor', 'claude', 'claude-cli'),
  ]);
  const refusedNoFam = chooseConsultant(noFam, 'plain-worker');
  assert.equal(refusedNoFam.worker, undefined);
  assert.match(refusedNoFam.reason ?? '', /model_family.*plain-worker/i);

  // 2. Same worker and same model_family (case-insensitive) are refused
  const sameFam = makeFixture(t, { enabled: true }, undefined, [
    makeWorker('gpt-worker', 'gpt', 'codex-cli'),
    makeWorker('gpt-peer', 'GPT', 'codex-cli'),
  ]);
  const refusedSameFam = chooseConsultant(sameFam, 'gpt-worker');
  assert.equal(refusedSameFam.worker, undefined);
  assert.match(refusedSameFam.reason ?? '', /outside model_family gpt/i);

  // 3. Explicit consult.role picks preferred worker; falls back to roles.verifier when consult.role is absent
  const withRole = makeFixture(t, { enabled: true, role: 'consultant' }, {
    consultant: { workers: { prefer: ['claude-advisor'] } },
    verifier: { workers: { prefer: ['claude-verifier'] } },
  });
  assert.equal(chooseConsultant(withRole, 'gpt-worker').worker?.id, 'claude-advisor');

  const fallbackVerifier = makeFixture(t, { enabled: true, role: 'consultant' }, {
    verifier: { workers: { only: ['claude-verifier'] } },
  });
  assert.equal(chooseConsultant(fallbackVerifier, 'gpt-worker').worker?.id, 'claude-verifier');

  // 4. Disabled workers and engines without verifierArgs (e.g. opencode / agy-cli) are skipped
  const skipDisabledAndUnsupported = makeFixture(t, { enabled: true }, {
    consultant: { workers: { prefer: ['disabled-claude', 'opencode-gemini', 'active-claude'] } },
  }, [
    makeWorker('gpt-worker', 'gpt', 'codex-cli'),
    makeWorker('disabled-claude', 'claude', 'claude-cli', { enabled: false }),
    { id: 'opencode-gemini', engine: 'opencode', model_family: 'gemini', aliases: [], launch: { program: 'opencode', args: ['run', '{prompt_file}'], template: 'synthetic' } },
    makeWorker('active-claude', 'claude', 'claude-cli'),
  ]);
  assert.equal(chooseConsultant(skipDisabledAndUnsupported, 'gpt-worker').worker?.id, 'active-claude');
});
