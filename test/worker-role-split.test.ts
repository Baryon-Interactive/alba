import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { validateWorkers } from '../src/workers/config.ts';
import { effectiveRoles, resolveRole, validateRoles } from '../src/roles/config.ts';
import { chooseWorker, rolePolicy, type Choosable, type RolePolicy } from '../src/routing/choose.ts';

const worker = (id: string, extra: Record<string, unknown> = {}): Choosable => ({
  config: validateWorkers({ workers: [{ id, engine: 'codex-cli', capabilities: ['shell', 'edit'], concurrency: 5, ...extra }] }, 'fixture.yaml').workers[0],
  available: true, reasons: [], running: 0, runsToday: 0, startable: true,
});
const choose = (workers: Choosable[], role: RolePolicy = { id: 'build' }, workerText?: string) => chooseWorker({ kind: 'code', tags: [], role, workerText }, workers);

test('supply schema validates capabilities and rejects removed worker fields', () => {
  const config = validateWorkers({ workers: [{ id: 'new', engine: 'card', capabilities: ['vision', 'studio-special'], notes: 'Weekly window' }] }, 'fixture.yaml');
  assert.deepEqual(config.extraCapabilities, ['studio-special']);
  assert.equal(config.workers[0].notes, 'Weekly window');
  for (const extra of [{ fits: { code: 3 } }, { kinds: ['review'] }, { profile: 'Obsolete' }]) assert.throws(() => worker('bad', extra), /unknown key/);
  for (const capabilities of ['shell', [1], ['']]) assert.throws(() => worker('bad', { capabilities }), /capabilities/);
});

test('roles resolve explicit, kind, default; no role cannot silently dispatch even a named worker', () => {
  const roles = validateRoles({ build: { kinds: ['code'], requires: ['shell'], effort: 'high', reasoning: 'deep' }, fallback: { default: true } }, 'roles.yaml');
  assert.equal(resolveRole(roles, { role: 'fallback', kind: 'code' }).source, 'explicit');
  assert.equal(resolveRole(roles, { kind: 'code' }).id, 'build');
  assert.equal(resolveRole(roles, { kind: 'unknown' }).source, 'default');
  assert.equal(resolveRole(validateRoles({ default: {} }, 'roles.yaml'), { kind: '' }).id, 'default');
  assert.throws(() => validateRoles({ default: {}, another: { default: true } }, 'roles.yaml'), /default/);
  assert.throws(() => validateRoles({ build: { requires: 'shell' } }, 'roles.yaml'), /requires/);
  assert.throws(() => validateRoles({ build: { workers: { only: 'coder' } } }, 'roles.yaml'), /only/);
  const noRole = chooseWorker({ kind: 'unknown', tags: [], workerText: 'coder' }, [worker('coder')]);
  assert.equal(noRole.outcome, 'nobody-fits'); assert.match(noRole.why, /no role/);
});

test('capabilities, avoid and only filter before rank; aliases and model families match role lists', () => {
  const workers = [worker('text'), worker('visual', { capabilities: ['vision'], aliases: ['Pictures'], model_family: 'visual-model' })];
  assert.equal(choose(workers, { requires: ['vision'] }).chosen, 'visual');
  assert.match(choose(workers, { requires: ['vision'] }).candidates.find(c => c.worker === 'text')!.reason, /missing capabilities: vision/);
  assert.equal(choose(workers, { only: ['Pictures'] }).chosen, 'visual');
  assert.equal(choose(workers, { only: [] }).outcome, 'nobody-fits');
  assert.equal(choose(workers, { avoid: ['visual-model'] }).chosen, 'text');
  assert.equal(choose(workers, { prefer: ['visual-model', 'text'] }).chosen, 'visual');
});

test('explicit worker overrides role restrictions with capability warning, retaining availability and limit checks', () => {
  const named = worker('text');
  const role = { requires: ['vision'], avoid: ['text'], only: [] };
  const choice = choose([named], role, 'text');
  assert.equal(choice.chosen, 'text'); assert.match(choice.why, /warning.*vision/);
  assert.equal(choice.candidates[0].warnings?.length, 1);
  named.config.enabled = false; assert.equal(choose([named], role, 'text').outcome, 'none-available');
  named.config.enabled = true; named.running = 5; assert.match(choose([named], role, 'text').why, /concurrency/);
  named.running = 0; named.config.daily_runs = 1; named.runsToday = 1; assert.match(choose([named], role, 'text').why, /daily limit/);
  named.runsToday = 0; named.overCap = true; assert.match(choose([named], role, 'text').why, /daily spend cap/);
  named.overCap = false; named.startable = false; assert.match(choose([named], role, 'text').why, /launch/);
  named.startable = true; named.available = false; named.reasons = ['quota exhausted']; assert.match(choose([named], role, 'text').why, /quota exhausted/);
});

test('rank is ordered role preference, reviewed role yield with three samples, cost, load, then file order', () => {
  const included = worker('included'), paid = worker('paid', { cost: 'paid' });
  included.roleHistory = { build: { samples: 3, rate: 0.2 }, other: { samples: 100, rate: 1 } };
  paid.roleHistory = { build: { samples: 3, rate: 1 } };
  assert.equal(choose([included, paid], { id: 'build', prefer: ['included', 'paid'] }).chosen, 'included');
  assert.equal(choose([included, paid]).chosen, 'paid');
  paid.roleHistory.build.samples = 2;
  assert.equal(choose([included, paid]).chosen, 'included');
  assert.equal(choose([included, paid]).candidates.find(c => c.worker === 'paid')!.history?.rate, undefined);
  included.roleHistory = undefined; paid.roleHistory = undefined;
  included.running = 4; assert.equal(choose([paid, included]).chosen, 'included');
  paid.config.cost = 'included'; assert.equal(choose([included, paid]).chosen, 'paid');
  included.running = 0; assert.equal(choose([included, paid]).chosen, 'included');
  assert.equal(choose([paid, included]).chosen, 'paid');
});
