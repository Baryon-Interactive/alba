import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { consultsFileOf, type ConsultRecord } from '../src/consult/config.ts';
import { fixture } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { tempOrders } from './helpers.ts';

test('API order detail, run detail, usage and spend include consults marked as consult', async () => {
  const f = await fixture({ populate: true, now: () => new Date('2026-06-15T12:10:00Z') });
  const stateDir = f.board.ctx.projects[0]!.state_dir;
  const doc = f.orders.get('W1');
  const run = doc.runs[0]!;
  const consultFile = consultsFileOf(stateDir, 'W1', run.id);
  mkdirSync(path.dirname(consultFile), { recursive: true });
  const record: ConsultRecord = {
    at: '2026-06-15T12:02:00.000Z',
    question: 'Should collision broadphase use sweep-and-prune or a uniform grid?',
    files: ['src/broadphase.ts'],
    consultant: 'claude-reviewer',
    engine: 'claude-cli',
    model: 'claude-sonnet-4-6',
    model_family: 'claude',
    seconds: 3.4,
    outcome: 'ok',
    answer_length: 62,
    answer: 'Use a uniform grid because entity radii are bounded and uniform.',
    usage: {
      source: 'claude-json',
      input_tokens: 500,
      output_tokens: 150,
      cached_tokens: 100,
      total_tokens: 750,
      cost_usd: 0.015,
    },
  };
  writeFileSync(consultFile, JSON.stringify(record) + '\n', 'utf8');

  // 1. Order detail includes consults on the run, consult spend, and accounting rows marked as consult
  const orderRes = await f.get('/api/orders/W1');
  assert.equal(orderRes.status, 200);
  const apiRun = orderRes.body.runs.find((r: { id: string }) => r.id === run.id);
  assert.equal(apiRun.consults.length, 1);
  assert.equal(apiRun.consults[0].consultant, 'claude-reviewer');
  assert.equal(apiRun.consults[0].answer, record.answer);
  assert.equal(orderRes.body.spend.consults, 1);
  assert.equal(orderRes.body.spend.consult_tokens, 750);
  assert.equal(orderRes.body.spend.consult_cost_usd, 0.015);
  assert.ok(orderRes.body.spend.total_tokens >= 750);

  const consultUsageRows = orderRes.body.accounting.rows.filter((r: { consult?: boolean }) => r.consult === true);
  assert.equal(consultUsageRows.length, 1);
  assert.equal(consultUsageRows[0].kind, 'consult');
  assert.equal(consultUsageRows[0].worker, 'claude-reviewer');
  assert.equal(consultUsageRows[0].total_tokens, 750);

  // 2. Run detail endpoint includes consults and returns 404 for unknown runs
  const runRes = await f.get(`/api/runs/W1:${run.id}`);
  assert.equal(runRes.status, 200);
  assert.equal(runRes.body.key, `W1:${run.id}`);
  assert.equal(runRes.body.consults.length, 1);
  assert.equal(runRes.body.consults[0].question, record.question);
  assert.equal(runRes.body.consults[0].outcome, 'ok');
  assert.equal((await f.get('/api/runs/W1:r99')).status, 404);

  // 3. Usage dashboard groups consult usage under kind "consult"
  const usageRes = await f.get('/api/usage/runs?since=30d');
  assert.equal(usageRes.status, 200);
  const consultKindGroup = usageRes.body.kinds.rows.find((g: { key: string }) => g.key === 'consult');
  assert.ok(consultKindGroup, 'usage by kind must include consult');
  assert.equal(consultKindGroup.tokens, 750);
});

test('alba orders show <TAG> lists consults of the open or last run', t => {
  const { dir } = tempOrders();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = projectDir(dir);
  alba(file, ['orders', 'add', 'CS1', '--title', 'Collision broadphase', '--kind', 'code']);
  alba(file, ['orders', 'act', 'CS1', 'queue']);
  alba(file, ['orders', 'run-start', 'CS1', '--worker', 'codex']);

  const consultFile = consultsFileOf(path.join(dir, 'state'), 'CS1', 'r1');
  mkdirSync(path.dirname(consultFile), { recursive: true });
  const rec: ConsultRecord = {
    at: '2026-06-15T12:05:00Z',
    question: 'Check sweep-and-prune tie breaking',
    consultant: 'claude-reviewer',
    model: 'claude-sonnet-4-6',
    seconds: 2.5,
    outcome: 'ok',
    answer_length: 30,
    answer: 'Sort by min endpoint then id.',
    usage: { source: 'claude-json', total_tokens: 320 },
  };
  writeFileSync(consultFile, JSON.stringify(rec) + '\n', 'utf8');

  // Listed while run r1 is open
  const openShow = alba(file, ['orders', 'show', 'CS1']);
  assert.equal(openShow.code, 0);
  assert.match(openShow.out, /Consults \(r1\):/);
  assert.match(openShow.out, /claude-reviewer \(claude-sonnet-4-6\)\s+ok\s+2\.5s\s+320 tok\s+Check sweep-and-prune tie breaking/);

  // Still listed after run r1 ends (as the last run)
  alba(file, ['orders', 'run-end', 'CS1', '--outcome', 'completed']);
  const endedShow = alba(file, ['orders', 'show', 'CS1']);
  assert.equal(endedShow.code, 0);
  assert.match(endedShow.out, /Consults \(r1\):/);
  assert.match(endedShow.out, /Check sweep-and-prune tie breaking/);
});
