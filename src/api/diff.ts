import { execFileSync } from 'node:child_process';
import type { DiffFile, OrderDiff } from './types.ts';

const FILE_PATCH_LIMIT = 200_000;
const TOTAL_PATCH_LIMIT = 2_000_000;
const MAX_PATCH_FILES = 300;
const MAX_COMMITS = 100;

const git = (cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): string =>
  execFileSync('git', ['--no-optional-locks', '-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

const STATUS: Record<string, DiffFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };

/**
 * The branch of an order against its base: `base...HEAD` in the order's worktree (what the branch added since it left the base, as a
 * merge would bring it). Read-only. A patch over 200 KB is cut; past 300 files or 2 MB of patches the remaining files come without one.
 */
export function orderDiff(project: string, tag: string, worktree: string, baseRef: string): OrderDiff {
  const range = `${baseRef}...HEAD`;
  const files = new Map<string, DiffFile>();
  const nameStatus = git(worktree, ['diff', '-M', '--name-status', '-z', range]).split('\0');
  for (let i = 0; i < nameStatus.length - 1;) {
    const code = nameStatus[i++];
    if (!code) continue;
    const kind = code[0];
    const from = kind === 'R' || kind === 'C' ? nameStatus[i++] : undefined;
    const path = nameStatus[i++];
    files.set(path, { path, ...(from ? { oldPath: from } : {}), status: STATUS[kind] ?? 'other', insertions: 0, deletions: 0, binary: false, truncated: false });
  }
  const numstat = git(worktree, ['diff', '-M', '--numstat', '-z', range]).split('\0');
  for (let i = 0; i < numstat.length - 1;) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(numstat[i++]);
    if (!m) continue;
    // a rename is "ins\tdel\t" followed by the old and the new path as separate fields
    const path = m[3] === '' ? (i++, numstat[i++]) : m[3];
    const file = files.get(path);
    if (!file) continue;
    if (m[1] === '-') file.binary = true; else { file.insertions = Number(m[1]); file.deletions = Number(m[2]); }
  }

  let note: string | undefined;
  let truncated = false;
  let patchText = '';
  try { patchText = git(worktree, ['diff', '-M', '--no-color', '--no-ext-diff', range]); }
  catch (e) {
    truncated = true;
    note = /maxBuffer/i.test((e as Error).message) ? 'The diff is too large to show; only the file list and counts are given.' : `The patches could not be read: ${(e as Error).message.split('\n')[0]}`;
  }
  let total = 0, shown = 0;
  for (const section of patchText.split(/^diff --git /m).slice(1)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? /^rename to (.+)$/m.exec(section)?.[1] ?? /^--- a\/(.+)$/m.exec(section)?.[1];
    const file = path ? files.get(path.replace(/\r$/, '')) : undefined;
    if (!file) continue;
    if (file.binary || /^Binary files /m.test(section)) { file.binary = true; file.note = 'Binary file: no patch.'; continue; }
    if (shown >= MAX_PATCH_FILES || total >= TOTAL_PATCH_LIMIT) { file.truncated = true; file.note = 'Left out: the diff is large (over 300 files or 2 MB of patches).'; truncated = true; continue; }
    let text = 'diff --git ' + section;
    if (text.length > FILE_PATCH_LIMIT) {
      text = text.slice(0, text.lastIndexOf('\n', FILE_PATCH_LIMIT) + 1 || FILE_PATCH_LIMIT);
      file.truncated = true;
      file.note = `The patch was cut at ${FILE_PATCH_LIMIT / 1000} KB.`;
      truncated = true;
    }
    file.patch = text;
    shown++;
    total += text.length;
  }
  if (truncated && !note) note = 'Some patches were cut or left out; see the note on each file.';

  const list = [...files.values()];
  let commits: OrderDiff['commits'] = [];
  try {
    commits = git(worktree, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%cI%x09%s', `${baseRef}..HEAD`]).split('\n').filter(Boolean)
      .map(l => { const [hash, at, ...subject] = l.split('\t'); return { hash, at: new Date(at).toISOString(), subject: subject.join('\t') }; });
  } catch { /* the stat above is still valid */ }
  const head = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return {
    project, tag, base: baseRef.replace(/^refs\/heads\//, ''), head, worktree, commits,
    stat: { files: list.length, insertions: list.reduce((n, f) => n + f.insertions, 0), deletions: list.reduce((n, f) => n + f.deletions, 0) },
    files: list, truncated, ...(note ? { note } : {}),
  };
}
