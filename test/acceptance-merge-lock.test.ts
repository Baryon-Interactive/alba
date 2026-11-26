import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acceptanceMergeRunning } from '../src/review/acceptance.ts';
import { tmpDir } from './tmp.ts';

test('a live merge lock means an acceptance merge is running; a missing or dead one does not', () => {
  const state_dir = tmpDir('alba-merge-lock-');
  const project = { state_dir } as any;
  assert.equal(acceptanceMergeRunning(project), false);
  mkdirSync(path.join(state_dir, 'acceptance'), { recursive: true });
  const file = path.join(state_dir, 'acceptance', 'merge-0.lock');
  writeFileSync(file, JSON.stringify({ pid: process.pid }));
  assert.equal(acceptanceMergeRunning(project), true);
  writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal(acceptanceMergeRunning(project), false);
});
