import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const removal = { recursive: true, force: true, maxRetries: 4, retryDelay: 100 };
const permissionError = error => ['EPERM', 'EACCES'].includes(error.code);

// Only repair the owned tree. In particular, never chmod or descend through a link/junction.
function writableSync(folder) {
  let stat;
  try { stat = lstatSync(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  chmodSync(folder, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of readdirSync(folder)) writableSync(path.join(folder, name));
}

async function writable(folder) {
  let stat;
  try { stat = await lstat(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  await chmod(folder, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of await readdir(folder)) await writable(path.join(folder, name));
}

function failed(folder, error, onError) {
  if (!onError) throw error;
  // Cleanup diagnostics must not replace a result or the error that caused cleanup.
  try { onError(`Cleanup deferred for ${folder}: ${error.message}`); } catch { /* diagnostic sink unavailable */ }
  return false;
}

/** Remove an owned tree with bounded lock retries and read-only repair. Throws unless onError is supplied. */
export function removeTreeSync(folder, { onError } = {}) {
  try {
    try { rmSync(folder, removal); }
    catch (error) {
      if (!permissionError(error)) throw error;
      writableSync(folder);
      rmSync(folder, removal);
    }
    return true;
  } catch (error) { return failed(folder, error, onError); }
}

/** The same policy without blocking the event loop during retries or traversal. */
export async function removeTree(folder, { onError } = {}) {
  try {
    try { await rm(folder, removal); }
    catch (error) {
      if (!permissionError(error)) throw error;
      await writable(folder);
      await rm(folder, removal);
    }
    return true;
  } catch (error) { return failed(folder, error, onError); }
}
