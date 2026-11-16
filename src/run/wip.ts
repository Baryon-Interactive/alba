import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EndKind } from './end-reason.ts';

export const MAX_WIP_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_WIP_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_WIP_SKIPPED_PATHS = 20;

export interface WipResult {
  wip_ref?: string;
  wip_files?: number;
  wip_skipped?: boolean;
  wip_skipped_paths?: string[];
  wip_error?: string;
}

export type GitRunner = (cwd: string, args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string }) => string;

export const defaultGitRunner: GitRunner = (cwd, args, options) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options?.env };
  delete env.ALBA_RUN;
  const res = spawnSync(
    'git',
    ['-C', cwd, '-c', 'user.name=Alba', '-c', 'user.email=alba@localhost', ...args],
    {
      env,
      input: options?.input,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: [options?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || `git ${args[0]} exited ${res.status}`).trim().split(/\r?\n/)[0] ?? 'git failed';
    throw new Error(detail);
  }
  return String(res.stdout ?? '');
};

export interface SaveWipOptions {
  tag: string;
  runId: string;
  kind: EndKind;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  runGit?: GitRunner;
}

function parsePorcelainZ(output: string): { candidate: string; extraDelete?: string }[] {
  const parts = output.split('\0');
  const items: { candidate: string; extraDelete?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy === '!!') continue;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const orig = parts[++i] ?? '';
      items.push({ candidate: filePath, ...(orig && (xy[0] === 'R' || xy[1] === 'R') ? { extraDelete: orig } : {}) });
    } else {
      items.push({ candidate: filePath });
    }
  }
  return items;
}

/**
 * Snapshots uncommitted and untracked (non-ignored) worktree changes to `refs/alba/wip/<TAG>-<runId>`
 * using a temporary `GIT_INDEX_FILE`, leaving the working tree, real index and HEAD untouched.
 */
export function saveWipSnapshot(worktree: string | undefined, options: SaveWipOptions): WipResult {
  if (options.kind === 'report') return {};
  if (!worktree || !existsSync(worktree)) return {};
  if (!options.runGit && !existsSync(path.join(worktree, '.git'))) return {};

  const runGit = options.runGit ?? defaultGitRunner;
  const maxFile = options.maxFileBytes ?? MAX_WIP_FILE_BYTES;
  const maxTotal = options.maxTotalBytes ?? MAX_WIP_TOTAL_BYTES;
  let tempDir: string | undefined;

  try {
    const statusOut = runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = parsePorcelainZ(statusOut);
    if (!entries.length) return {};

    const toStage: string[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    let totalExceeded = false;

    for (const { candidate, extraDelete } of entries) {
      if (extraDelete) toStage.push(extraDelete);
      const full = path.join(worktree, candidate);
      let size = 0;
      let present = false;
      try {
        const st = lstatSync(full);
        present = true;
        size = st.isSymbolicLink() ? 0 : st.size;
      } catch {
        present = false;
      }
      if (!present) {
        toStage.push(candidate);
        continue;
      }
      if (totalExceeded) {
        skipped.push(candidate);
        continue;
      }
      if (size > maxFile) {
        skipped.push(candidate);
        continue;
      }
      if (totalBytes + size > maxTotal) {
        totalExceeded = true;
        skipped.push(candidate);
        continue;
      }
      totalBytes += size;
      toStage.push(candidate);
    }

    const skipMeta: Pick<WipResult, 'wip_skipped' | 'wip_skipped_paths'> = skipped.length
      ? { wip_skipped: true, wip_skipped_paths: skipped.slice(0, MAX_WIP_SKIPPED_PATHS) }
      : {};

    if (!toStage.length) return skipMeta;

    const head = runGit(worktree, ['rev-parse', '--verify', 'HEAD']).trim();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'alba-wip-'));
    const tempIndex = path.join(tempDir, 'index');
    const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndex };

    runGit(worktree, ['read-tree', head], { env: indexEnv });
    if (!skipped.length) {
      runGit(worktree, ['add', '-A'], { env: indexEnv });
    } else {
      runGit(worktree, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env: { ...indexEnv, GIT_LITERAL_PATHSPECS: '1' },
        input: toStage.join('\0'),
      });
    }

    const tree = runGit(worktree, ['write-tree'], { env: indexEnv }).trim();
    const changed = runGit(worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head, tree])
      .split('\0')
      .filter(Boolean);
    if (!changed.length) return skipMeta;

    const ref = `refs/alba/wip/${options.tag}-${options.runId}`;
    const message = `WIP snapshot for ${options.tag} ${options.runId} (${options.kind})\n`;
    const commit = runGit(worktree, ['commit-tree', tree, '-p', head], { input: message }).trim();
    runGit(worktree, ['update-ref', ref, commit]);

    return {
      wip_ref: ref,
      wip_files: changed.length,
      ...skipMeta,
    };
  } catch (e) {
    return { wip_error: ((e as Error).message ?? String(e)).replace(/\s+/g, ' ').trim().slice(0, 240) };
  } finally {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
}
