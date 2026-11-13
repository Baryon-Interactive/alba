import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Machines page in English and Chinese at 1440×900', { skip: !process.env.ALBA_BROWSER ? 'Set ALBA_BROWSER to a Chromium executable to run the optional native browser check.' : false, timeout: 120000 }, () => {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/machines-browser.mjs'], { encoding: 'utf8', timeout: 110000, windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
