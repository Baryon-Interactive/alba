import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { latestLimits, readCodexSessions, windowName } from '../src/workers/codex-quota.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { availability } from '../src/workers/quota.ts';
import { tmpDir } from './tmp.ts';

/** A token_count line as Codex writes it into a session file. */
const tokenCount = (timestamp: string, primary: unknown, secondary: unknown, credits: unknown = null) => JSON.stringify({
  timestamp, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } }, rate_limits: { limit_id: 'codex', primary, secondary, credits, plan_type: 'pro' } },
});

function session(home: string, day: string, name: string, lines: string[], mtime: number): void {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, lines.join('\n') + '\n');
  utimesSync(file, mtime, mtime);
}

test('codex-sessions: the newest session file with limits gives the windows, named by length; nothing is run', () => {
  const home = tmpDir('alba-codex-home-');
  const resets5h = Math.floor(Date.parse('2026-11-13T15:00:00Z') / 1000), resets7d = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);
  session(home, '2026/11/12', 'rollout-2026-11-12T08-00-00-aaaa.jsonl', [
    tokenCount('2026-11-12T08:00:00Z', { used_percent: 90, window_minutes: 300, resets_at: 1 }, null),
  ], 4000); // written last (a long session), but its limits are the oldest: passed over
  session(home, '2026/11/13', 'rollout-2026-11-13T09-00-00-bbbb.jsonl', [
    '{"timestamp":"2026-11-13T09:00:00Z","type":"session_meta","payload":{}}',
    tokenCount('2026-11-13T09:01:00Z', { used_percent: 12, window_minutes: 300, resets_at: resets5h }, { used_percent: 30, window_minutes: 10080, resets_at: resets7d }),
    tokenCount('2026-11-13T09:05:00Z', { used_percent: 14.5, window_minutes: 300, resets_at: resets5h }, { used_percent: 31, window_minutes: 10080, resets_at: resets7d }, { has_credits: true, unlimited: false, balance: '120.5000' }),
  ], 2000);
  // Written last, by a session signed in with an API key: no windows, so it is passed over.
  session(home, '2026/11/13', 'rollout-2026-11-13T10-00-00-cccc.jsonl', [tokenCount('2026-11-13T10:00:00Z', null, null)], 3000);

  const reading = readCodexSessions('codex-plan', { type: 'codex-sessions', codex_home: home }, '2026-11-13T12:00:00.000Z');
  assert.equal(reading.ok, true);
  assert.deepEqual(reading.windows, [
    { name: '5 hours', usedPercent: 14.5, resetsAt: '2026-11-13T15:00:00.000Z' },
    { name: '7 days', usedPercent: 31, resetsAt: '2026-11-18T00:00:00.000Z' },
  ]);
  assert.deepEqual(reading.balance, { raw: '120.5 credits', amount: 120.5 });

  // After the 5 hour window has reset, it reads as unused; the worker rule then follows the 7 day one.
  const later = readCodexSessions('codex-plan', { type: 'codex-sessions', codex_home: home }, '2026-11-13T16:00:00.000Z');
  assert.deepEqual(later.windows[0], { name: '5 hours', usedPercent: 0 });

  const file = validateWorkers({
    quota_sources: { 'codex-plan': { type: 'codex-sessions', codex_home: home } },
    workers: [{ id: 'cx', engine: 'codex-cli', quota: 'codex-plan', launch: { template: 't', program: 'codex', args: ['exec', '{prompt_file}'] }, disabled_when: [{ window_full: '7 days', at: 30 }] }],
  }, path.join(home, 'workers.yaml'));
  assert.deepEqual(file.quota_sources['codex-plan'], { type: 'codex-sessions', codex_home: home });
  const state = availability(file.workers[0]!, reading, [], new Date('2026-11-13T12:00:00Z'));
  assert.equal(state.available, false);
  assert.match(state.reasons.join(' '), /window "7 days" is 31% used/);
});

test('codex-sessions: a missing home is an error, a home without limits yet is a reading without windows, and the config is checked', () => {
  const home = tmpDir('alba-codex-home-');
  const missing = readCodexSessions('codex-plan', { type: 'codex-sessions', codex_home: path.join(home, 'nope') }, '2026-11-13T12:00:00.000Z');
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /no Codex sessions folder at .*nope\/sessions/);
  mkdirSync(path.join(home, 'sessions'));
  assert.deepEqual(readCodexSessions('codex-plan', { type: 'codex-sessions', codex_home: home }, '2026-11-13T12:00:00.000Z'), { source: 'codex-plan', at: '2026-11-13T12:00:00.000Z', ok: true, windows: [], entries: 0 });
  // CODEX_HOME is the default.
  assert.equal(readCodexSessions('x', { type: 'codex-sessions' }, '2026-11-13T12:00:00.000Z', { CODEX_HOME: home }).ok, true);
  assert.throws(() => validateWorkers({ quota_sources: { q: { type: 'codex-sessions', codex_home: 'relative/home' } }, workers: [] }, path.join(home, 'workers.yaml')), /codex_home" must be an absolute folder/);
  assert.throws(() => validateWorkers({ quota_sources: { q: { type: 'codex-sessions', command: ['codex'] } }, workers: [] }, path.join(home, 'workers.yaml')), /unknown key\(s\): command/);
});

test('codex rate limits: older exec events, seconds-after resets and app-server notices are read the same way', () => {
  const exec = '{"id":"0","timestamp":"2026-11-13T10:00:00Z","msg":{"type":"token_count","rate_limits":{"primary":{"used_percent":40,"window_minutes":300,"resets_in_seconds":600},"secondary":null}}}';
  assert.deepEqual(latestLimits(`{"type":"turn.started"}\n${exec}\n{"type":"turn.completed"}`), { windows: [{ name: '5 hours', usedPercent: 40, resetsAt: '2026-11-13T10:10:00.000Z' }], observedAt: '2026-11-13T10:00:00Z' });
  const notice = '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":1795139668}}}}';
  assert.deepEqual(latestLimits(notice)!.windows, [{ name: '7 days', usedPercent: 5, resetsAt: new Date(1795139668000).toISOString() }]);
  assert.equal(latestLimits('{"type":"turn.completed","usage":{"input_tokens":1}}'), undefined);
  assert.equal(windowName(60, 'primary'), '1 hour');
  assert.equal(windowName(90, 'primary'), '90 minutes');
  assert.equal(windowName(undefined, 'primary'), 'primary');
});
