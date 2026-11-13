import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { processSnapshotAsync, stopTreeAsync } from '../src/run/kill-tree.ts';

test('POSIX native stop validates identity and ends the real parent and child', {
  skip: process.platform === 'win32' ? 'Requires the Linux or macOS ps implementation; Windows has separate native tests.' : false,
  timeout: 30_000,
}, async () => {
  const parent = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(parent, 'exit');
  let child = 0;
  try {
    const [chunk] = await once(parent.stdout!, 'data');
    child = Number(String(chunk).trim());
    assert.ok(child > 0);
    const snapshot = await processSnapshotAsync();
    const root = snapshot.find(p => p.pid === parent.pid)!;
    assert.ok(root);
    const wrong = await stopTreeAsync({ pid: root.pid, startedAt: new Date(Date.parse(root.createdAt) + 60_000).toISOString(), notBefore: Date.now() });
    assert.equal(wrong.stopped.length, 0);
    const result = await stopTreeAsync({ pid: root.pid, startedAt: root.createdAt, notBefore: Date.parse(root.createdAt) }, 20_000);
    assert.equal(result.gone, true, result.problem);
    assert.ok(result.stopped.includes(root.pid));
    assert.ok(result.stopped.includes(child));
    await exit;
  } finally {
    parent.kill();
    // This PID was obtained directly from the child we launched, never discovered by a name search.
    if (child) try { process.kill(child, 'SIGKILL'); } catch { /* already reaped */ }
  }
});
