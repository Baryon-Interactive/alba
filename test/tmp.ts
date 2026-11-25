// Temporary folders for tests. Every folder made here is removed when its test ends (pass the test context) or, at the
// latest, when the test process exits, also after a failed assertion. `scripts/run-tests.mjs` gives each run its own
// temporary folder and fails the run if a test leaves anything in it, so use this instead of `mkdtempSync` directly.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeStateStores } from '../src/orders/backend.ts';
import { closeMachineStores } from '../src/resources/machine-store.ts';

const made = new Set<string>();

/** Removes a folder made by `tmpDir`. Windows file locks (an open SQLite file, a process still in the folder) can outlast
 * the retries: the folder then stays registered for the exit sweep, which closes the state stores first. */
export function removeTmpDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    made.delete(dir);
    return true;
  } catch { return false; }
}

/** Makes a fresh folder `<parent>/<prefix>XXXXXX` (parent defaults to the system temporary folder) that is removed when `t`
 * ends, or when the process exits if no test context is given. */
export function tmpDir(prefix = 'alba-test-', options: { t?: { after(fn: () => void): void }; parent?: string } = {}): string {
  const parent = options.parent ?? tmpdir();
  if (options.parent) mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, prefix));
  made.add(dir);
  options.t?.after(() => { removeTmpDir(dir); });
  return dir;
}

process.on('exit', () => {
  if (!made.size) return;
  try { closeStateStores(); } catch { /* already closed */ }
  try { closeMachineStores(); } catch { /* already closed */ }
  const failed = [...made].filter(dir => !removeTmpDir(dir));
  if (failed.length) process.stderr.write(`test/tmp.ts: could not remove ${failed.length} temporary folder(s): ${failed.slice(0, 5).join(', ')}\n`);
});
