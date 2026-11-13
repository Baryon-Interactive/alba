import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from '../i18n.ts';
import type { WorkerConfig } from '../workers/config.ts';
import type { SelectedSkill } from './registry.ts';

/**
 * Where each engine reads project skills from (found by running each one on a worktree with a skill folder in every
 * place it might look; see docs/012). `.agents/skills` is read by Codex and Grok; opencode reads it too but not when its
 * external skills are switched off, so it gets its own folder, which survives every switch.
 */
export const ENGINE_MOUNTS: Record<string, string[]> = {
  'codex-cli': ['.agents/skills'],
  'grok-cli': ['.agents/skills'],
  'claude-cli': ['.claude/skills'],
  opencode: ['.opencode/skills'],
};
export const DEFAULT_MOUNTS = ['.agents/skills'];

/** The folders (relative to the worktree) skills are put in for this worker. */
export const mountsFor = (worker: Pick<WorkerConfig, 'engine' | 'skills_mount'>): string[] => worker.skills_mount?.length ? worker.skills_mount : ENGINE_MOUNTS[worker.engine] ?? DEFAULT_MOUNTS;

const MANIFEST = '.alba-skills.json';
const BEGIN = '# alba skills (managed by Alba, safe to delete)';

interface Manifest { version: 1; skills: Record<string, string> }

/** A short signature of a skill folder: relative path, size and modified time of every file. Equal signature: nothing to copy. */
export function folderSignature(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else if (e.isFile()) { const s = statSync(p); parts.push(`${rel}${e.name}:${s.size}:${Math.round(s.mtimeMs)}`); }
    }
  };
  walk(dir, '');
  return parts.join('|');
}

function gitOut(cwd: string, args: string[]): string {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

/** Adds lines to `info/exclude` of the repository the worktree belongs to (once each), so the copies never show up as changes. */
export function excludeLocally(worktree: string, lines: readonly string[]): void {
  const raw = gitOut(worktree, ['rev-parse', '--git-path', 'info/exclude']).trim();
  if (!raw) return;
  const file = path.resolve(worktree, raw);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/));
  const add = lines.filter(l => !have.has(l));
  if (!add.length) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const head = text.includes(BEGIN) ? '' : `${text && !text.endsWith('\n') ? '\n' : ''}${BEGIN}\n`;
  writeFileSync(file, `${text}${head}${add.join('\n')}\n`, 'utf8');
}

const readManifest = (root: string): Manifest => {
  try {
    const v = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8')) as Manifest;
    return v?.version === 1 && v.skills && typeof v.skills === 'object' ? v : { version: 1, skills: {} };
  } catch { return { version: 1, skills: {} }; }
};

export interface MountResult {
  /** Names that are in the worktree now. */
  mounted: string[];
  /** Names removed because they are no longer selected. */
  removed: string[];
  /** Names that were already there and unchanged. */
  unchanged: string[];
  problems: string[];
}

/**
 * Puts the selected skills into the worktree by copying (never by link), once per mount folder:
 *  - a skill the tool put there earlier and that is no longer selected is removed; nothing else in the folder is touched
 *    (the tool's own list is `.alba-skills.json` in the folder);
 *  - a skill whose folder exists and was not put there by the tool, or whose files git tracks, is left alone and reported;
 *  - the copies and the list are named in the repository's `info/exclude`, so they are never committed.
 * It runs at every start of a run and keeps to the registry as it is then.
 */
/** A skill folder name that stays inside the mount folder (the list file lives in the worktree, where a worker can edit it). */
export function safeSkillName(root: string, name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !/^\.+$/.test(name) && path.dirname(path.resolve(root, name)) === path.resolve(root);
}

export function mountSkills(worktree: string, mounts: readonly string[], selected: readonly SelectedSkill[]): MountResult {
  const result: MountResult = { mounted: [], removed: [], unchanged: [], problems: [] };
  const excludes: string[] = [];
  for (const mount of mounts) {
    const root = path.join(worktree, mount);
    mkdirSync(root, { recursive: true });
    const manifest = readManifest(root);
    const next: Manifest = { version: 1, skills: {} };
    const rel = mount.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const name of Object.keys(manifest.skills)) {
      if (selected.some(s => s.skill.name === name)) continue;
      if (!safeSkillName(root, name)) { result.problems.push(t('{path} names a skill "{name}" outside the folder; not removed.', { path: `${rel}/${MANIFEST}`, name })); continue; }
      if (gitOut(worktree, ['ls-files', '--', `${rel}/${name}`]).trim()) { result.problems.push(t('{path} is tracked by git; left alone.', { path: `${rel}/${name}` })); continue; }
      rmSync(path.join(root, name), { recursive: true, force: true });
      if (!result.removed.includes(name)) result.removed.push(name);
    }
    for (const { skill } of selected) {
      if (!safeSkillName(root, skill.name)) { result.problems.push(t('skill "{name}" has a name that cannot be a folder name; left out.', { name: skill.name, path: '' })); continue; }
      const target = path.join(root, skill.name);
      const signature = folderSignature(skill.dir);
      const managed = skill.name in manifest.skills;
      if (existsSync(target) && !managed) { result.problems.push(t('{path} exists and was not put there by alba; left alone.', { path: `${rel}/${skill.name}` })); continue; }
      if (gitOut(worktree, ['ls-files', '--', `${rel}/${skill.name}`]).trim()) { result.problems.push(t('{path} is tracked by git; left alone.', { path: `${rel}/${skill.name}` })); continue; }
      if (managed && manifest.skills[skill.name] === signature && existsSync(path.join(target, 'SKILL.md'))) {
        next.skills[skill.name] = signature;
        if (!result.unchanged.includes(skill.name)) result.unchanged.push(skill.name);
      } else {
        rmSync(target, { recursive: true, force: true });
        cpSync(skill.dir, target, { recursive: true, filter: src => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
        next.skills[skill.name] = signature;
      }
      if (!result.mounted.includes(skill.name)) result.mounted.push(skill.name);
      excludes.push(`/${rel}/${skill.name}/`);
    }
    writeFileSync(path.join(root, MANIFEST), JSON.stringify(next, null, 2) + '\n', 'utf8');
    excludes.push(`/${rel}/${MANIFEST}`);
  }
  excludeLocally(worktree, [...new Set(excludes)]);
  return result;
}
