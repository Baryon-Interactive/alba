import { execFileSync } from 'node:child_process';
import type { ChecksConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';

export interface CheckItem { name: string; ok: boolean; detail: string }

/** `**` crosses folders, `*` and `?` do not; a pattern ending in `/` means everything under that folder. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; } }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const matchesAny = (globs: readonly string[], file: string) => globs.some(g => globToRegExp(g).test(file));

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', cwd, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    return fail('git {args} failed in {cwd}: {why}', { args: args.join(' '), cwd, why: String(err.stderr ?? err.message).trim().split('\n')[0] });
  }
}

interface Changed { status: string; path: string }

/** Files the branch added (A), changed (M) or removed (D) since it left the base. */
export function changedFiles(worktree: string, baseRef: string): Changed[] {
  return git(worktree, ['diff', '--name-status', '--no-renames', `${baseRef}...HEAD`]).split('\n').filter(Boolean).map(line => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], path: rest.join('\t') };
  });
}

/** Lines the branch added that hold a run of "?" or the replacement character: the mark of text that passed through a code page. */
export function encodingProblems(worktree: string, baseRef: string): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  let file = '', line = 0;
  for (const l of git(worktree, ['diff', '--unified=0', '--no-color', '--no-renames', `${baseRef}...HEAD`]).split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]) - 1; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      line++;
      if (/\?{4,}|\uFFFD/.test(l) && file && file !== '/dev/null') out.push({ file, line, text: l.slice(1, 81) });
    }
  }
  return out;
}

/**
 * JSON files the branch added or changed whose committed text starts with a UTF-8 byte order mark (Windows PowerShell's UTF8
 * encoding writes one). JSON.parse and Python's json refuse them.
 */
export function jsonByteOrderMarks(worktree: string, baseRef: string, changed = changedFiles(worktree, baseRef)): string[] {
  return changed.filter(c => c.status !== 'D' && /\.json$/i.test(c.path)).map(c => c.path).filter(file => {
    try { return git(worktree, ['show', `HEAD:${file}`]).startsWith('\uFEFF'); } catch { return false; }
  });
}

const shorten = (list: readonly string[], n = 4) => list.slice(0, n).join(', ') + (list.length > n ? t(' and {more} more', { more: list.length - n }) : '');

/** The checks that need nothing but git and the project's rules. Each one can be switched off in `checks:`. */
export function generalChecks(cfg: ChecksConfig, worktree: string, baseRef: string): CheckItem[] {
  const items: CheckItem[] = [];
  const base = baseRef.replace(/^refs\/heads\//, '');
  if (cfg.clean_worktree) {
    const dirty = git(worktree, ['status', '--porcelain']).split('\n').filter(Boolean);
    items.push({ name: t('worktree is clean'), ok: !dirty.length, detail: dirty.length ? t('{n} uncommitted file(s): {list}', { n: dirty.length, list: shorten(dirty.map(d => d.slice(3))) }) : '' });
  }
  if (cfg.ahead_of_base) {
    const ahead = Number(git(worktree, ['rev-list', '--count', `${baseRef}..HEAD`]).trim());
    items.push({ name: t('branch is ahead of {base}', { base }), ok: ahead > 0, detail: t('{n} commit(s) ahead', { n: ahead }) });
  }
  const changed = (cfg.protected_paths.length || cfg.forbidden_tracked.length || cfg.max_new_file_kb) ? changedFiles(worktree, baseRef) : [];
  if (cfg.protected_paths.length) {
    const hit = changed.filter(c => matchesAny(cfg.protected_paths, c.path)).map(c => c.path);
    items.push({ name: t('protected paths are unchanged'), ok: !hit.length, detail: hit.length ? t('changed: {list}', { list: shorten(hit) }) : '' });
  }
  if (cfg.forbidden_tracked.length) {
    const hit = changed.filter(c => c.status !== 'D' && matchesAny(cfg.forbidden_tracked, c.path)).map(c => c.path);
    items.push({ name: t('no forbidden paths added or changed'), ok: !hit.length, detail: hit.length ? t('tracked: {list}', { list: shorten(hit) }) : '' });
  }
  if (cfg.encoding_scan) {
    const bad = encodingProblems(worktree, baseRef);
    items.push({ name: t('added text has no "????" or U+FFFD'), ok: !bad.length, detail: bad.length ? shorten(bad.map(b => `${b.file}:${b.line}`)) : '' });
    const marked = jsonByteOrderMarks(worktree, baseRef);
    items.push({ name: t('no JSON file the branch changed starts with a byte order mark'), ok: !marked.length, detail: marked.length ? t('{list}: write these as UTF-8 without a byte order mark', { list: shorten(marked) }) : '' });
  }
  if (cfg.max_new_file_kb) {
    const limit = cfg.max_new_file_kb * 1024;
    const big = changed.filter(c => c.status === 'A').map(c => ({ path: c.path, size: Number(git(worktree, ['cat-file', '-s', `HEAD:${c.path}`]).trim()) })).filter(f => f.size > limit);
    items.push({ name: t('no added file over {kb} KB', { kb: cfg.max_new_file_kb }), ok: !big.length, detail: big.length ? shorten(big.map(b => `${b.path} (${Math.round(b.size / 1024)} KB)`)) : '' });
  }
  return items;
}
