import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';

const helper = fileURLToPath(new URL('../src/run/lock-helper.mjs', import.meta.url));

test('lock.mjs: two runs take turns at a named lock; the command\'s exit code comes back; a dead holder\'s lock is taken over', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-lock-'));
  try {
    const env = { ...process.env, ALBA_LOCK_DIR: dir };
    const log = path.join(dir, 'order.txt');
    // Each command appends "start", waits a moment, appends "end": inside one lock they never overlap.
    const step = (name: string) => `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${name} start\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'${name} end\\n');process.exit(${name === 'a' ? 3 : 0})},700)`;
    const run = (name: string) => new Promise<{ code: number | null; err: string }>(resolve => {
      const p = spawn(process.execPath, [helper, 'capture', '--', process.execPath, '-e', step(name)], { env });
      let err = ''; p.stderr.on('data', d => { err += d; }); p.on('close', code => resolve({ code, err }));
    });
    const first = run('a');
    await new Promise(r => setTimeout(r, 200));
    const [a, b] = await Promise.all([first, run('b')]);
    assert.equal(a.code, 3);
    assert.equal(b.code, 0);
    assert.match(b.err, /waiting for the "capture" lock, held by pid \d+/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['a start', 'a end', 'b start', 'b end']);
    // A lock left by a process that is gone does not block.
    writeFileSync(path.join(dir, 'capture.lock'), JSON.stringify({ pid: 999999, cwd: 'gone', since: 'earlier' }));
    assert.equal(spawnSync(process.execPath, [helper, 'capture', '--', process.execPath, '-e', 'process.exit(0)'], { env, timeout: 20000 }).status, 0);
    assert.equal(spawnSync(process.execPath, [helper, 'bad name!', '--', 'x'], { env }).status, 2);
  } finally { removeTreeSync(dir); }
});
