import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { descendantPids, processStartMatches, stopProcessTreeVerified, stopProcessOnly, stopProcessTree, treeMembers } from '../src/run/kill-tree.ts';
import { systemProbes } from '../src/tick/gather.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (what: () => boolean, ms = 20000) => {
  const until = Date.now() + ms;
  while (!what() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  return what();
};

test('descendant walk excludes stale parent pids and their children, and stops real grandchildren before parents', () => {
  const p = (pid: number, parentPid: number, seconds: number) => ({ pid, parentPid, createdAt: new Date(seconds * 1000).toISOString() });
  const processes = [p(10, 0, 10), p(20, 10, 9), p(21, 20, 11), p(30, 10, 10), p(40, 30, 12), p(50, 30, 9), p(60, 10, 13)];
  assert.deepEqual(descendantPids(processes, 10), [40, 30, 60]);
  assert.deepEqual(descendantPids(processes, 999), []);
  assert.deepEqual(descendantPids([...processes, { pid: 70, parentPid: 10, createdAt: 'unknown' }], 10), [40, 30, 60]);
  assert.deepEqual(descendantPids([p(1, 2, 10), p(2, 1, 10)], 1), [2], 'cycles cannot revisit the root');
});

test('root identity requires the exact recorded OS creation time', () => {
  const at = '2026-01-01T00:00:00.123Z';
  assert.equal(processStartMatches(at, at), true);
  assert.equal(processStartMatches(at, '2026-01-01T00:00:00.124Z'), false);
  assert.equal(processStartMatches(at, undefined), false);
  assert.equal(processStartMatches('unknown', 'unknown'), false);
});

test('observed descendants bridge exited parents and exclude reused parent identities', () => {
  const p = (pid: number, parentPid: number, seconds: number) => ({ pid, parentPid, createdAt: new Date(seconds * 1000).toISOString() });
  const root = p(10, 0, 10), parent = p(20, 10, 11), child = p(30, 20, 12);
  const target = { pid: root.pid, startedAt: root.createdAt, notBefore: 10_000, members: [root, parent, child] };
  assert.deepEqual(treeMembers([child], target).map(p => p.pid), [30]);
  assert.deepEqual(treeMembers([child, p(20, 1, 20), p(40, 20, 21)], target).map(p => p.pid), [30]);
  assert.deepEqual(treeMembers([p(30, 1, 30)], target), []);
});

for (const persistent of [false, true]) test(`snapshot failure ${persistent ? 'reports unlisted descendants and stops the verified root' : 'retries and stops the tree'}`, async () => {
  const root = spawn(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio:'ignore', detached:true, windowsHide:true });
    console.log(child.pid);
    setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let child = 0;
  try {
    child = Number(String((await once(root.stdout!, 'data'))[0]).trim());
    assert.ok(root.pid && child > 0);
    const rootAt = systemProbes.processStartedAt!(root.pid), childAt = systemProbes.processStartedAt!(child);
    assert.ok(rootAt && childAt);
    let attempts = 0;
    const snapshot = () => {
      attempts++;
      if (persistent || attempts === 1) throw new Error('Fixture listing failure');
      return [{ pid: root.pid!, parentPid: process.pid, createdAt: rootAt }, { pid: child, parentPid: root.pid!, createdAt: childAt }];
    };
    const result = stopProcessTreeVerified(root.pid, rootAt, { snapshot });
    assert.equal(attempts, 2);
    assert.deepEqual(result.stopped, persistent ? [root.pid] : [child, root.pid]);
    assert.equal(result.problem, persistent ? 'listing' : undefined);
    if (persistent) assert.ok(alive(child));
    assert.ok(await waitFor(() => !alive(root.pid!)));
  } finally {
    if (child && alive(child)) process.kill(child);
    if (root.pid && alive(root.pid)) root.kill();
  }
});

for (const tree of [true, false]) {
  test(`Windows ${tree ? 'tree' : 'lingering'} stop validates the root and ${tree ? 'ends' : 'preserves'} its real child`, { skip: process.platform !== 'win32' ? 'Requires Windows native process identity and CIM; POSIX has a separate native tree test.' : false }, async () => {
    // An older unrelated process represents the orphan with a stale ppid; Windows cannot assign its ppid for us.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    let parent: ReturnType<typeof spawn> | undefined;
    let child = 0;
    let startedAt: string | undefined;
    try {
      const olderAt = systemProbes.processStartedAt!(unrelated.pid!);
      assert.ok(olderAt);
      parent = spawn(process.execPath, ['-e', `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }); console.log(c.pid); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      let output = '';
      parent.stdout!.on('data', chunk => { output += chunk; });
      assert.ok(await waitFor(() => /^\d+\s/.test(output)), 'stand-in parent starts its child');
      child = Number(output.trim());
      startedAt = systemProbes.processStartedAt!(parent.pid!);
      const childAt = systemProbes.processStartedAt!(child);
      assert.ok(startedAt && childAt);
      assert.ok(Date.parse(olderAt) < Date.parse(startedAt));
      // Synthetic reuse of the stand-in pid proves the actual older process would be excluded by the same walk.
      assert.deepEqual(descendantPids([
        { pid: parent.pid!, parentPid: 0, createdAt: startedAt },
        { pid: child, parentPid: parent.pid!, createdAt: childAt },
        { pid: unrelated.pid!, parentPid: parent.pid!, createdAt: olderAt },
      ], parent.pid!), [child]);
      const wrongTime = new Date(Date.parse(startedAt) + 1).toISOString();
      assert.deepEqual(stopProcessTree(parent.pid!, wrongTime), []);
      assert.deepEqual(stopProcessOnly(parent.pid!, wrongTime), { stopped: [], leftRunning: [] });
      assert.deepEqual(stopProcessTree(parent.pid!, undefined), []);
      assert.ok(alive(parent.pid!) && alive(child) && alive(unrelated.pid!));
      const result = tree ? { stopped: stopProcessTree(parent.pid!, startedAt), leftRunning: [] } : stopProcessOnly(parent.pid!, startedAt);
      // Windows can also start a console host under our stand-in; its pid is allowed in the result.
      assert.equal(result.stopped.at(-1), parent.pid!);
      assert.equal(result.stopped.includes(child), tree);
      assert.equal(result.stopped.includes(unrelated.pid!), false);
      assert.equal(result.leftRunning.includes(child), !tree);
      assert.equal(result.leftRunning.includes(unrelated.pid!), false);
      assert.ok(await waitFor(() => !alive(parent!.pid!)), 'the stand-in parent ends');
      if (tree) assert.ok(await waitFor(() => !alive(child)), 'the real child ends');
      else assert.ok(alive(child), 'a lingering worker leaves the background job alive');
      assert.ok(alive(unrelated.pid!), 'the unrelated older process remains alive');
    } finally {
      // Cleanup is limited to the processes this test started.
      if (child && alive(child)) process.kill(child);
      if (parent?.pid && alive(parent.pid)) parent.kill();
      if (unrelated.pid && alive(unrelated.pid)) unrelated.kill();
    }
  });
}
