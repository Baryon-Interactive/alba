import type { ProjectConfig } from '../config.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { ownerOf } from '../usage/spend.ts';
import type { WorkersFile } from '../workers/config.ts';

/**
 * Projects served together share one workers file: the same accounts and machines. A worker's `concurrency` is how many runs it
 * takes at once over all of them, so each project's tick counts the runs the other projects have open on it ("peers"), and a
 * start records its run under a lock that every project's thread takes (`withFleetLock`), so two projects never both take the
 * last slot of a worker.
 */

/** Open runs of the other projects, by worker id (a run names its worker by id or alias). */
export function peerRunning(peers: readonly ProjectConfig[], workers: WorkersFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const project of peers) {
    let docs;
    try { docs = new Orders(stateStore(project)).all(); } catch { continue; }   // a peer that cannot be read counts nothing
    for (const doc of docs) for (const run of doc.runs) {
      if (run.ended !== undefined) continue;
      const id = ownerOf(workers.workers, run.worker)?.id;
      if (id) out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/** A mutex over the threads of one serve process: an Int32 in a SharedArrayBuffer every project's thread is given. */
let lock: Int32Array | undefined;
export const newFleetLock = (): SharedArrayBuffer => new SharedArrayBuffer(4);
export function useFleetLock(buffer: SharedArrayBuffer | undefined): void { lock = buffer ? new Int32Array(buffer) : undefined; }

/** Runs `f` holding the fleet lock (without one, in a single process of its own, `f` just runs). Keep `f` short: no child processes. */
export function withFleetLock<T>(f: () => T): T {
  if (!lock) return f();
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) Atomics.wait(lock, 0, 1, 100);
  try { return f(); } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0, 1); }
}
