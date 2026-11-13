import { systemProbes, type Probes } from '../src/tick/gather.ts';
/** A deterministic 200 ms synchronous gather, with no model, git or machine probes. */
export const probes: Probes = {
  ...systemProbes,
  runCommand: () => '[]', runCommandAsync: async () => '[]',
  freeRamGb: () => 32, freeRamGbAsync: async () => 32,
  worktrees() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); return []; },
  gitActivity: () => ({}), gitActivityAsync: async () => ({}),
  fileTime: () => undefined, isAlive: () => true, tail: () => '', head: () => '', readText: () => undefined,
  spawnDetached() { throw new Error('Performance fixture must never dispatch'); },
};
