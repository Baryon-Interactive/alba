import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The environment variable every worker process gets: `<TAG>/<run>`. The guard hook acts only while it is set. */
export const RUN_ENV = 'ALBA_RUN';
const MARK = '# alba-base-guard v1';
const HOOK = 'reference-transaction';

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The hook. Git runs `reference-transaction` for every ref update in the repository and all its worktrees; with `prepared` as its
 * argument a non-zero exit aborts the update. While ALBA_RUN is set (a worker and everything it starts) it refuses to move a
 * protected branch; a person's or Alba's own commits and merges (no ALBA_RUN) pass, and so does everything on other branches,
 * including `git merge main` inside a worker's worktree. A ref rewritten with the same value (packing refs) passes.
 */
export function guardHook(protectedRefs: readonly string[]): string {
  const list = [...new Set(protectedRefs)].sort();
  return [
    '#!/bin/sh',
    MARK,
    '# Written by Alba (src/run/ref-guard.ts) and rewritten when a run starts; Alba leaves a hook without this mark alone.',
    `# protected: ${list.join(' ')}`,
    `[ -n "$${RUN_ENV}" ] || exit 0`,
    '[ "$1" = prepared ] || exit 0',
    'while read -r old new ref; do',
    '  [ "$old" = "$new" ] && continue',
    `  case " ${list.join(' ')} " in`,
    '    *" $ref "*)',
    '      # Packing refs (git pack-refs, git gc) writes the value the branch has into packed-refs, then deletes the loose file.',
    '      [ "$new" = "$(git rev-parse -q --verify "$ref" 2>/dev/null)" ] && continue',
    '      case "$new" in *[!0]*) ;; *) grep -q "^$old $ref\\$" "$(git rev-parse --git-common-dir)/packed-refs" 2>/dev/null && continue ;; esac',
    `      echo "alba: this is the worker run $${RUN_ENV}; it may not move $ref (the base branch). Commit on your order's branch in your worktree; the lead merges it. If git already changed files here, leave them and name the command in your report." >&2`,
    `      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $${RUN_ENV} $ref $old $new $(pwd)" >> "$(git rev-parse --git-common-dir)/alba-guard.log" 2>/dev/null`,
    '      exit 1 ;;',
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Puts the guard hook into the repository's shared hooks folder, protecting `baseRef` (and any branch an earlier install protected).
 * Returns a warning instead when it cannot be done without touching something that is not Alba's: a `core.hooksPath` (the hooks of
 * the project or of every repository), or a `reference-transaction` hook someone else wrote.
 */
export function installBaseGuard(root: string, baseRef: string): { installed: boolean; warning?: string } {
  let hooksPath = '';
  try { hooksPath = git(root, ['config', '--get', 'core.hooksPath']); } catch { /* not set */ }
  if (hooksPath) return { installed: false, warning: `the base-branch guard hook was not installed: core.hooksPath is set (${hooksPath}); a worker run is not stopped from moving ${baseRef}` };
  const dir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']), 'hooks');
  const file = path.join(dir, HOOK);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (before !== undefined && !before.includes(MARK)) return { installed: false, warning: `the base-branch guard hook was not installed: ${file.replace(/\\/g, '/')} exists and is not Alba's; a worker run is not stopped from moving ${baseRef}` };
  const earlier = /^# protected: (.*)$/m.exec(before ?? '')?.[1]?.split(' ').filter(Boolean) ?? [];
  const text = guardHook([...earlier, baseRef]);
  if (text !== before) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { encoding: 'utf8' });
    try { chmodSync(file, 0o755); } catch { /* Windows: Git for Windows runs it without the bit */ }
  }
  return { installed: true };
}
