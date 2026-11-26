import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { validateProject } from '../src/config.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { createBoard } from '../src/web/server.ts';
import type { Probes } from '../src/tick/gather.ts';
import { tmpDir } from './tmp.ts';

// With port 0 the board asks for a free port first and listens later. Closing it before then must stop it from listening at all;
// otherwise a serve stopped right after it started keeps a server open and its process never exits.
test('a board closed before its free port arrives never starts listening', async () => {
  const dir = tmpDir('alba-early-close-');
  try {
    const root = path.join(dir, 'game');
    mkdirSync(path.join(root, 'orders'), { recursive: true });
    const project = validateProject({ id: 'demo', name: 'Demo', root, work_orders: path.join(root, 'orders'), state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
    const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'x', enabled: false }] }, 'w.yaml');
    const probes = {
      now: () => new Date(), runCommand: () => '[]', freeRamGb: () => 32, worktrees: () => [], gitActivity: () => ({}), fileTime: () => undefined,
      isAlive: () => false, tail: () => '', readText: () => undefined, spawnDetached: () => 1,
    } as unknown as Probes;
    const board = createBoard({ projects: [project], workers, port: 0, probes, snapshotTtlMs: 0, uiDir: path.join(dir, 'no-ui') });
    let listened = false;
    board.server.once('listening', () => { listened = true; });
    board.server.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(listened, false);
    assert.equal(board.server.listening, false);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the board's state store may still hold a file on Windows */ }
  }
});
