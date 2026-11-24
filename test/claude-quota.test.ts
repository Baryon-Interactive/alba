import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeLimitsOfLine, claudeRunLogFiles, claudeWindowName, latestClaudeLimits, readClaudeStream } from '../src/workers/claude-quota.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { availability } from '../src/workers/quota.ts';
import { tick, type Probes } from '../src/tick/gather.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';

function writeLog(dir: string, name: string, lines: string[], mtimeSec: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

test('claude-stream: parses top-level only, unifiedWindows only, merged, rejected without utilization, unknown types, and broken lines', () => {
  const resets5h = Math.floor(Date.parse('2026-11-24T17:00:00Z') / 1000);
  const resets7d = Math.floor(Date.parse('2026-11-30T00:00:00Z') / 1000);
  const resetsOpus = Math.floor(Date.parse('2026-11-30T00:00:00Z') / 1000);
  const resetsSonnet = Math.floor(Date.parse('2026-11-30T00:00:00Z') / 1000);

  // 1. Top-level only
  const topOnly = JSON.stringify({
    alba_at: '2026-11-24T12:00:00Z',
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.42,
      resetsAt: resets5h,
    },
  });
  const rTop = claudeLimitsOfLine(topOnly);
  assert.deepEqual(rTop, {
    observedAt: '2026-11-24T12:00:00.000Z',
    windows: [{ name: '5 hours', usedPercent: 42, resetsAt: '2026-11-24T17:00:00.000Z' }],
  });

  // 2. unifiedWindows only (including opus, sonnet, and an unknown custom window type)
  const unifiedOnly = JSON.stringify({
    alba_at: '2026-11-24T12:05:00Z',
    type: 'rate_limit_event',
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: 0.29, resetsAt: resets5h, status: 'allowed' },
        seven_day: { utilization: 0.65, resetsAt: resets7d, status: 'allowed_warning' },
        seven_day_opus: { utilization: 0.125, resetsAt: resetsOpus, status: 'allowed' },
        seven_day_sonnet: { utilization: 0.8, resetsAt: resetsSonnet, status: 'allowed' },
        monthly_extra: { utilization: 0.5, resetsAt: resets7d, status: 'allowed' },
      },
    },
  });
  const rUnified = claudeLimitsOfLine(unifiedOnly);
  assert.deepEqual(rUnified?.windows, [
    { name: '5 hours', usedPercent: 29, resetsAt: '2026-11-24T17:00:00.000Z' },
    { name: '7 days', usedPercent: 65, resetsAt: '2026-11-30T00:00:00.000Z' },
    { name: '7 days opus', usedPercent: 12.5, resetsAt: '2026-11-30T00:00:00.000Z' },
    { name: '7 days sonnet', usedPercent: 80, resetsAt: '2026-11-30T00:00:00.000Z' },
    { name: 'monthly_extra', usedPercent: 50, resetsAt: '2026-11-30T00:00:00.000Z' },
  ]);

  // 3. Both (merge): top-level status belongs ONLY to rateLimitType and does not leak to other unifiedWindows entries
  const merged = JSON.stringify({
    alba_at: '2026-11-24T12:10:00Z',
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: resets5h,
      unifiedWindows: {
        five_hour: { resetsAt: resets5h, status: 'allowed' },
        seven_day: { utilization: 0.35, resetsAt: resets7d, status: 'allowed' },
        seven_day_opus: { status: 'allowed' },
      },
    },
  });
  const rMerged = claudeLimitsOfLine(merged);
  assert.deepEqual(rMerged?.windows, [
    { name: '5 hours', usedPercent: 100, resetsAt: '2026-11-24T17:00:00.000Z' },
    { name: '7 days', usedPercent: 35, resetsAt: '2026-11-30T00:00:00.000Z' },
  ]);

  // 4. rejected without utilization (top-level only) counts as 100%
  const rejected = JSON.stringify({
    alba_at: '2026-11-24T12:15:00Z',
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt: resets7d,
    },
  });
  assert.deepEqual(claudeLimitsOfLine(rejected)?.windows, [
    { name: '7 days', usedPercent: 100, resetsAt: '2026-11-30T00:00:00.000Z' },
  ]);

  // 5. Broken lines are skipped cleanly
  const text = [
    '{"type":"assistant","message":{"content":[]}}',
    topOnly,
    '{"type":"rate_limit_event","rate_limit_info":{broken json',
    'not json at all rate_limit_event',
  ].join('\n');
  assert.deepEqual(latestClaudeLimits(text)?.windows, rTop?.windows);
  assert.equal(claudeWindowName('custom_window'), 'custom_window');
});

test('claude-stream: passed reset reads 0%, max_age_hours yields ok reading with note, newest observation wins over newer file mtime', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-claude-quota-'));
  try {
    const resets5h = Math.floor(Date.parse('2026-11-24T15:00:00Z') / 1000);
    const resets7d = Math.floor(Date.parse('2026-11-30T00:00:00Z') / 1000);

    // Log A has older mtime (2000) but NEWER observation (12:30Z)
    const logA = writeLog(dir, 'T1-r1.events.jsonl', [
      '{"type":"system","subtype":"init"}',
      JSON.stringify({
        alba_at: '2026-11-24T12:30:00Z',
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.42,
          resetsAt: resets5h,
          unifiedWindows: {
            five_hour: { utilization: 0.42, resetsAt: resets5h, status: 'allowed' },
            seven_day: { utilization: 0.71, resetsAt: resets7d, status: 'allowed_warning' },
          },
        },
      }),
    ], 2000);

    // Log B has newer mtime (5000) but OLDER observation (10:00Z)
    const logB = writeLog(dir, 'T2-r1.events.jsonl', [
      JSON.stringify({
        alba_at: '2026-11-24T10:00:00Z',
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.95,
          resetsAt: resets5h,
        },
      }),
      '{"type":"rate_limit_event", truncated line',
    ], 5000);

    // Newest observation (logA: 42% / 71%) wins even though logB has newer mtime
    const reading = readClaudeStream('claude-sub', { type: 'claude-stream' }, '2026-11-24T13:00:00.000Z', [logA, logB]);
    assert.equal(reading.ok, true);
    assert.deepEqual(reading.windows, [
      { name: '5 hours', usedPercent: 42, resetsAt: '2026-11-24T15:00:00.000Z' },
      { name: '7 days', usedPercent: 71, resetsAt: '2026-11-30T00:00:00.000Z' },
    ]);

    // After 5h reset passes (16:00Z), 5 hours reads 0% while 7 days keeps 71%
    const afterReset = readClaudeStream('claude-sub', { type: 'claude-stream' }, '2026-11-24T16:00:00.000Z', [logA, logB]);
    assert.equal(afterReset.ok, true);
    assert.deepEqual(afterReset.windows, [
      { name: '5 hours', usedPercent: 0 },
      { name: '7 days', usedPercent: 71, resetsAt: '2026-11-30T00:00:00.000Z' },
    ]);

    // Beyond max_age_hours: ok reading with no windows and a note (not a failure)
    const stale = readClaudeStream('claude-sub', { type: 'claude-stream', max_age_hours: 2 }, '2026-11-24T15:00:00.000Z', [logA, logB]);
    assert.equal(stale.ok, true);
    assert.deepEqual(stale.windows, []);
    assert.equal(stale.entries, 0);
    assert.ok(stale.note && stale.note.includes('2'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-stream: config validation and tick integration', () => {
  const { orders, dir } = tempOrders();
  try {
    const workersFile = path.join(dir, 'workers.yaml');
    const valid = validateWorkers({
      quota_sources: { 'claude-sub': { type: 'claude-stream' } },
      workers: [{
        id: 'claude-main',
        engine: 'claude-cli',
        quota: 'claude-sub',
        disabled_when: [{ window_full: '5 hours', at: 95 }],
        launch: { program: 'claude', model: 'sonnet', args: [], env: { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN}' } },
      }],
    }, workersFile);
    assert.deepEqual(valid.quota_sources['claude-sub'], { type: 'claude-stream' });

    const withAge = validateWorkers({
      quota_sources: { 'claude-sub': { type: 'claude-stream', max_age_hours: 24 } },
      workers: [{
        id: 'claude-main',
        engine: 'claude-cli',
        quota: 'claude-sub',
        launch: { program: 'claude', model: 'sonnet', args: [] },
      }],
    }, workersFile);
    assert.deepEqual(withAge.quota_sources['claude-sub'], { type: 'claude-stream', max_age_hours: 24 });

    // Config validation errors
    assert.throws(() => validateWorkers({
      quota_sources: { q: { type: 'claude-stream', max_age_hours: 0 } },
      workers: [{ id: 'c', engine: 'claude-cli', quota: 'q' }],
    }, workersFile), /"max_age_hours" must be a positive number/);
    assert.throws(() => validateWorkers({
      quota_sources: { q: { type: 'claude-stream', max_age_hours: -5 } },
      workers: [{ id: 'c', engine: 'claude-cli', quota: 'q' }],
    }, workersFile), /"max_age_hours" must be a positive number/);
    assert.throws(() => validateWorkers({
      quota_sources: { q: { type: 'claude-stream', max_age_hours: '24' } },
      workers: [{ id: 'c', engine: 'claude-cli', quota: 'q' }],
    }, workersFile), /"max_age_hours" must be a positive number/);
    assert.throws(() => validateWorkers({
      quota_sources: { q: { type: 'claude-stream', extra: true } },
      workers: [{ id: 'c', engine: 'claude-cli', quota: 'q' }],
    }, workersFile), /unknown key\(s\): extra/);

    // Tick integration: reads rate_limit_event from run's events_file and applies disabled_when
    const runsDir = path.join(dir, 'state', 'runs');
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(path.join(dir, 'orders'), { recursive: true });
    const resets5h = Math.floor(Date.parse('2026-11-24T17:00:00Z') / 1000);
    const eventsFile = writeLog(runsDir, 'T1-r1.events.jsonl', [
      JSON.stringify({
        alba_at: '2026-11-24T12:00:00Z',
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resets5h },
      }),
    ], Math.floor(Date.parse('2026-11-24T12:00:00Z') / 1000));

    orders.add({ tag: 'T1', title: 'Demo', kind: 'code' });
    orders.act('T1', 'queue');
    orders.runStart('T1', { worker: 'claude-main', extra: { engine: 'claude-cli', events_file: eventsFile } });
    orders.runEnd('T1', 'completed');

    const logs = claudeRunLogFiles(valid, 'claude-sub', orders.all());
    assert.deepEqual(logs, [eventsFile]);

    const project = validateProject({
      id: 'demo',
      name: 'Demo',
      root: dir,
      work_orders: path.join(dir, 'orders'),
      state_dir: path.join(dir, 'state'),
      dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main' },
    }, path.join(dir, 'alba.yaml'));
    const probes: Probes = {
      now: () => new Date('2026-11-24T12:30:00Z'),
      runCommand: () => { throw new Error('must not run external command'); },
      freeRamGb: () => 32,
      worktrees: () => [],
      gitActivity: () => ({}),
      fileTime: () => undefined,
      isAlive: () => false,
      tail: () => '',
      readText: () => undefined,
      spawnDetached: () => 1,
    };
    const res = tick(project, orders, valid, probes, { record: false });
    const q = res.quotas.find(x => x.source === 'claude-sub');
    assert.ok(q?.ok);
    assert.deepEqual(q?.windows, [{ name: '5 hours', usedPercent: 100, resetsAt: '2026-11-24T17:00:00.000Z' }]);
    const wState = availability(valid.workers[0]!, q, [], new Date('2026-11-24T12:30:00Z'));
    assert.equal(wState.available, false);
    assert.match(wState.reasons.join(' '), /window "5 hours" is 100% used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
