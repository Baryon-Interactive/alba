import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerEnvironment } from '../src/run/environment.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.ts';

test('worker environment strips control-plane settings, preserves provider credentials, applies explicit values and then removals', () => {
  const env = workerEnvironment({ ALBA_PROJECT: 'private', alba_future_setting: 'private', ALBA_TOKEN: 'private', CONSOLE_TOKEN: 'private', SERVICE_AUTH_TOKEN: 'private', SERVER_TOKEN: 'private', TOKEN_CONTROL: 'private', OPENAI_API_KEY: 'model-credential', PATH: 'tools', ordinary: 'keep' }, { ALBA_LAST_FILE: 'report.txt', ALBA_PROJECT: 'blocked', ALBA_SERVICE_TOKEN: 'blocked', SERVICE_TOKEN: 'blocked', ordinary: 'override' }, ['PATH']);
  assert.deepEqual(env, { OPENAI_API_KEY: 'model-credential', ordinary: 'override', ALBA_LAST_FILE: 'report.txt' });
});

test('ordinary variable overrides and removals retain native platform case semantics', () => {
  assert.deepEqual(workerEnvironment({ Path: 'inherited' }, { PATH: 'explicit' }, ['path'], 'win32'), {});
  assert.deepEqual(workerEnvironment({ Path: 'inherited' }, { PATH: 'explicit' }, ['path'], 'linux'), { Path: 'inherited', PATH: 'explicit' });
});

test('one-shot verifier subprocesses use the same worker environment boundary', async () => {
  const dir = tmpDir('alba-verifier-env-');
  const saved = process.env.ALBA_SERVICE_TOKEN;
  process.env.ALBA_SERVICE_TOKEN = 'parent-control-value';
  try {
    const log = path.join(dir, 'worker.log');
    const result = await systemProbes.runWorkerOnce!({ program: process.execPath, args: ['-e', 'console.log(JSON.stringify({token:process.env.ALBA_SERVICE_TOKEN,report:process.env.ALBA_LAST_FILE}))'], cwd: dir, env: { ALBA_LAST_FILE: 'report.txt' }, envUnset: [], logFile: log, timeoutSeconds: 10 });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), { report: 'report.txt' });
  } finally {
    if (saved === undefined) delete process.env.ALBA_SERVICE_TOKEN; else process.env.ALBA_SERVICE_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
