import { removeTree } from '../fs/remove-tree.mjs';
import type { ProjectConfig } from '../config.ts';
import { worktreeGit } from './command.ts';

/**
 * Removes a scratch checkout without blocking the event loop. Git may unregister a Windows worktree before failing to remove a
 * locked folder, so the fallback deletes the folder asynchronously and prunes. Returns a problem text when something stayed behind.
 */
export async function removeScratch(project: ProjectConfig, folder: string, timeoutMs: number): Promise<string | undefined> {
  try { await worktreeGit(project.root, ['worktree', 'remove', '--force', '--force', folder], timeoutMs); }
  catch {
    let problem: string | undefined;
    try { await removeTree(folder); }
    catch (error) { problem = `Scratch cleanup deferred: ${(error as Error).message}`; }
    try { await worktreeGit(project.root, ['worktree', 'prune'], 60_000); }
    catch (error) { problem ??= `Scratch prune deferred: ${(error as Error).message}`; }
    return problem;
  }
}

/** Creates the detached checkout; a failed attempt removes what it left behind and reports why. */
export async function addScratch(project: ProjectConfig, folder: string, commit: string, timeoutMs: number): Promise<string | undefined> {
  try { await worktreeGit(project.root, ['worktree', 'add', '--detach', folder, commit], timeoutMs); return undefined; }
  catch (error) {
    const problem = await removeScratch(project, folder, timeoutMs);
    throw Object.assign(error as Error, { cleanup: problem });
  }
}
