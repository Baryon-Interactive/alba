import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { removeTree, removeTreeSync } from '../src/fs/remove-tree.mjs';
import { runRemote } from '../src/workers/adapters/remote-run.mjs';
import { tmpDir } from './tmp.ts';

test('owned tree cleanup removes read-only files and directories without changing link targets', async () => {
  const root = tmpDir('alba-remote-cleanup-');
  try {
    const outside = path.join(root, 'retained'); mkdirSync(outside);
    const retained = path.join(outside, 'object'); writeFileSync(retained, 'retained'); chmodSync(retained, 0o444);
    const mode = statSync(retained).mode;
    for (const remove of [removeTreeSync, removeTree]) {
      const tree = path.join(root, 'stage'), nested = path.join(tree, 'objects'); mkdirSync(nested, { recursive: true });
      const object = path.join(nested, 'read-only'); writeFileSync(object, 'git object'); chmodSync(object, 0o444);
      symlinkSync(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      chmodSync(nested, 0o555); chmodSync(tree, 0o555);
      assert.equal(await remove(tree), true);
      assert.equal(existsSync(tree), false);
      assert.equal(statSync(retained).mode, mode);
      assert.equal(fs.readFileSync(retained, 'utf8'), 'retained');
    }
  } finally { removeTreeSync(root); }
});

test('read-only repair stays within the owned tree after a permission failure', t => {
  const root = tmpDir('alba-remote-repair-');
  const nativeRemove = fs.rmSync;
  try {
    const outside = path.join(root, 'retained'); mkdirSync(outside); chmodSync(outside, 0o555);
    const mode = statSync(outside).mode;
    const tree = path.join(root, 'stage'); mkdirSync(tree);
    symlinkSync(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(tree, 'object'), 'read only'); chmodSync(path.join(tree, 'object'), 0o444);
    let attempts = 0;
    t.mock.method(fs, 'rmSync', (folder: fs.PathLike, options: fs.RmOptions) => {
      if (++attempts === 1) throw Object.assign(new Error('read only'), { code: 'EPERM' });
      return nativeRemove(folder, options);
    });
    syncBuiltinESMExports();
    assert.equal(removeTreeSync(tree), true);
    assert.equal(attempts, 2);
    assert.equal(statSync(outside).mode, mode);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); removeTreeSync(root); }
});

test('unremovable remote staging is diagnostic and preserves worker exit codes and primary errors', async t => {
  const dir = tmpDir('alba-remote-deferred-');
  const nativeRemove = fs.rmSync;
  try {
    const prompt = path.join(dir, 'prompt.md'); writeFileSync(prompt, 'Prompt');
    const spec = { id: 'task-r1', os: 'windows', local_stage: path.join(dir, 'stage'), local_worktree: dir, overlay_roots: [], order_files: [], prompt_file: prompt, rewrite: [], workspace: path.join(dir, 'host'), ssh: 'stand-in', branch: 'task', sync_minutes: 3 };
    t.mock.method(fs, 'rmSync', (folder: fs.PathLike, options: fs.RmOptions) => {
      if (/^remote-(stage|result)-/.test(path.basename(String(folder)))) throw Object.assign(new Error('held open'), { code: 'EBUSY' });
      return nativeRemove(folder, options);
    });
    syncBuiltinESMExports();
    const run = ((_program: string, args: string[]) => ({ status: args.includes('fetch') ? 1 : 0, stdout: '', stderr: '' })) as typeof spawnSync;
    for (const exit of [9, 0]) {
      const notes: string[] = [];
      const start = ((program: string, args: string[], options: any) => spawn(process.execPath, ['-e', `process.stdin.resume(); process.exit(${program === 'ssh' && args.at(-1)!.includes('-Mode run') ? exit : 0})`], options)) as typeof spawn;
      const result = runRemote(spec, { run, spawn: start, say: text => notes.push(text) });
      if (exit) assert.equal(await result, exit);
      else await assert.rejects(result, /Remote commits could not be synchronized/);
      assert.ok(notes.some(text => /Cleanup deferred.*held open/.test(text)));
    }
    assert.doesNotThrow(() => removeTreeSync(path.join(dir, 'remote-stage-test'), { onError: () => { throw new Error('broken logger'); } }));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); removeTreeSync(dir); }
});

test('Windows synchronous and async cleanup retry a temporary exclusive file lock', { skip: process.platform !== 'win32' ? 'Windows file sharing semantics' : false, timeout: 20_000 }, async () => {
  for (const remove of [removeTreeSync, removeTree]) {
    const dir = tmpDir('alba-remote-lock-');
    const file = path.join(dir, 'object'); writeFileSync(file, 'locked briefly');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:ALBA_TEST_LOCK, 'Open', 'Read', 'None'); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 350; $f.Dispose()"], { windowsHide: true, env: { ...process.env, ALBA_TEST_LOCK: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('Lock holder exited before acquiring its file'); })]);
      assert.match(String(ready[0]), /locked/);
      assert.equal(await remove(dir), true);
      assert.equal(existsSync(dir), false);
      assert.equal((await closed)[0], 0);
    } finally { if (child.exitCode === null) child.kill(); await closed; removeTreeSync(dir); }
  }
});
