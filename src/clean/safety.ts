import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

/** Package roots may live on another drive, but must never cover the checkout or traverse links. */
export function safePackageRoot(dir: string, projectRoot: string): boolean {
  const full = path.resolve(dir), root = path.resolve(projectRoot);
  const relative = path.relative(full, root);
  if (full === path.parse(full).root || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return false;
  try { if (lstatSync(full).isSymbolicLink()) return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  // Missing future artifact folders are allowed; inspect every existing ancestor.
  let parent = path.dirname(full);
  for (;;) {
    try { if (lstatSync(parent).isSymbolicLink()) return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    const next = path.dirname(parent); if (next === parent) return true; parent = next;
  }
}

/** Reject an ancestor junction: unlinking a leaf must never traverse a linked parent. */
export function linkedAncestor(target: string): boolean {
  let dir = path.dirname(path.resolve(target));
  for (;;) {
    try { if (lstatSync(dir).isSymbolicLink()) return true; } catch { return true; }
    const parent = path.dirname(dir);
    if (dir === parent) return false;
    dir = parent;
  }
}

interface SnapshotOptions {
  entries?: number;
  seconds?: number;
  depth?: number;
}

/** Metadata snapshot. Links are fingerprinted themselves and never followed. */
export function cleanSignature(targets: string[], failure?: (reason: string) => void, options: SnapshotOptions = {}): string | undefined {
  const hash = createHash('sha256');
  let entries = 0;
  const deadline = Date.now() + (options.seconds ?? 5) * 1000;
  function walk(file: string, depth = 0): void {
    if (++entries > (options.entries ?? 100000) || Date.now() > deadline) throw new Error('Snapshot limit');
    const st = lstatSync(file);
    // Handle the link before directory metadata/recursion. Its destination may be
    // inaccessible, dangling, cyclic, or contain more entries than our budget.
    if (st.isSymbolicLink()) { hash.update(JSON.stringify([file, 'link', readlinkSync(file)])); return; }
    hash.update(JSON.stringify([file, st.mode, st.size, st.mtimeMs, st.ctimeMs, st.ino]));
    if (st.isDirectory() && depth < (options.depth ?? Infinity)) for (const name of readdirSync(file).sort()) walk(path.join(file, name), depth + 1);
  }
  try { for (const file of targets) { if (linkedAncestor(file)) throw new Error('An ancestor is a link or cannot be inspected.'); walk(file); } return hash.digest('hex'); }
  catch (error) { failure?.((error as Error).message.split('\n')[0]); return; }
}

/** Git protects source changes; only the top two metadata levels of ignored output are inspected. */
export function worktreeSignature(dir: string, runGit: (cwd: string, args: string[]) => string, failure?: (reason: string) => void): string | undefined {
  try {
    const head = runGit(dir, ['rev-parse', '--verify', 'HEAD']).trim();
    const branch = runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (!head || !branch) throw new Error('Cannot read worktree HEAD or branch.');
    if (runGit(dir, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Worktree contains uncommitted files.');
    // Full-walk budgets apply to disposable artifact targets, not to worktrees.
    const metadata = cleanSignature([dir], failure, { depth: 2, entries: Infinity, seconds: Infinity });
    if (!metadata) return;
    return createHash('sha256').update(JSON.stringify([head, branch, metadata])).digest('hex');
  } catch (error) { failure?.((error as Error).message.split('\n')[0]); return; }
}
