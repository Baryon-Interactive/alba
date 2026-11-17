import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../config.ts';
import { orderTraits } from '../foundations/foundations.ts';
import { fail } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { CaptureConfig, CaptureDoneMode, CaptureRecipe, CaptureShotConfig } from './types.ts';

export type { CaptureConfig, CaptureDoneMode, CaptureRecipe, CaptureShotConfig } from './types.ts';

const SHOT_NAME = /^[A-Za-z0-9_-]+$/;
const RECIPE_NAME = /^[A-Za-z0-9_-]+$/;
const LOCK_NAME = /^[A-Za-z0-9_.-]+$/;

export const BUILD_PLACEHOLDERS = new Set(['tag', 'worktree', 'out_dir', 'revision', 'alba', 'alba_skills']);
export const SHOT_PLACEHOLDERS = new Set(['tag', 'worktree', 'out', 'out_dir', 'shot', 'revision', 'alba', 'alba_skills']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Alba's own package root directory (`src/capture/config.ts` or `dist/capture/config.js` -> `../..`). */
export function albaPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function checkPlaceholders(text: string, allowed: ReadonlySet<string>, file: string, where: string): void {
  const matches = text.matchAll(/\{([^{}]*)\}/g);
  for (const m of matches) {
    const token = m[1];
    if (!allowed.has(token)) {
      fail('{file}: "{where}" contains unknown placeholder "{placeholder}".', { file, where, placeholder: `{${token}}` });
    }
  }
  const stripped = text.replace(/\{[^{}]*\}/g, '');
  if (stripped.includes('{') || stripped.includes('}')) {
    fail('{file}: "{where}" contains an unclosed placeholder brace.', { file, where });
  }
}

function validateCommandArray(raw: unknown, file: string, where: string, allowedPlaceholders: ReadonlySet<string>, allowEmpty = false): string[] {
  if (typeof raw === 'string') {
    fail('{file}: "{where}" must be a command array, never a shell string.', { file, where });
  }
  if (!Array.isArray(raw) || (!allowEmpty && !raw.length) || raw.some(v => typeof v !== 'string' || v.includes('\0'))) {
    fail('{file}: "{where}" must be a list of argument strings.', { file, where });
  }
  if (!allowEmpty && !(raw[0] as string).trim()) {
    fail('{file}: "{where}" must start with a non-empty program name.', { file, where });
  }
  for (const arg of raw as string[]) checkPlaceholders(arg, allowedPlaceholders, file, where);
  return [...(raw as string[])];
}

function validateWordList(raw: unknown, file: string, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string' || !v.trim())) {
    fail('{file}: "{where}" must be a list of non-empty strings.', { file, where });
  }
  return [...new Set((raw as string[]).map(v => v.trim().toLowerCase()))];
}

function validatePositiveNumber(raw: unknown, file: string, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    fail('{file}: "{where}" must be a number > 0.', { file, where });
  }
  return raw;
}

function validateNonNegativeNumber(raw: unknown, file: string, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    fail('{file}: "{where}" must be a number >= 0.', { file, where });
  }
  return raw;
}

const RECIPE_KEYS = [
  'name', 'kinds', 'tags', 'lock', 'lock_wait_minutes', 'timeout_minutes',
  'build', 'build_timeout_minutes', 'artifact', 'size', 'launch', 'done',
  'baseline', 'min_change', 'timeout_seconds', 'shots',
] as const;

const SHOT_KEYS = ['name', 'args', 'command', 'timeout_seconds', 'done'] as const;

export function validateCapture(raw: unknown, file: string): CaptureConfig {
  if (!isRecord(raw)) fail('{file}: "capture" must be a mapping.', { file });
  const unknownTop = Object.keys(raw).filter(k => k !== 'recipes');
  if (unknownTop.length) fail('{file}: unknown key(s) under "capture": {keys}.', { file, keys: unknownTop.map(k => `capture.${k}`).join(', ') });
  if (!Array.isArray(raw.recipes) || !raw.recipes.length) {
    fail('{file}: "capture.recipes" must be a non-empty list of recipes.', { file });
  }

  const seenRecipes = new Set<string>();
  const recipes: CaptureRecipe[] = raw.recipes.map((entry, rIndex): CaptureRecipe => {
    const rAt = `capture.recipes[${rIndex}]`;
    if (!isRecord(entry)) fail('{file}: "{where}" must be a mapping.', { file, where: rAt });
    const badRecipeKeys = Object.keys(entry).filter(k => !(RECIPE_KEYS as readonly string[]).includes(k));
    if (badRecipeKeys.length) {
      fail('{file}: unknown key(s) under "{where}": {keys}.', { file, where: rAt, keys: badRecipeKeys.map(k => `${rAt}.${k}`).join(', ') });
    }

    if (typeof entry.name !== 'string' || !RECIPE_NAME.test(entry.name)) {
      fail('{file}: "{where}" must match [A-Za-z0-9_-]+.', { file, where: `${rAt}.name` });
    }
    if (seenRecipes.has(entry.name)) {
      fail('{file}: "{where}" duplicates recipe name "{name}".', { file, where: `${rAt}.name`, name: entry.name });
    }
    seenRecipes.add(entry.name);

    const kinds = validateWordList(entry.kinds, file, `${rAt}.kinds`);
    const tags = validateWordList(entry.tags, file, `${rAt}.tags`);

    const lock = entry.lock === undefined ? 'capture' : entry.lock;
    if (typeof lock !== 'string' || !LOCK_NAME.test(lock)) {
      fail('{file}: "{where}" must be a valid lock name ([A-Za-z0-9_.-]+).', { file, where: `${rAt}.lock` });
    }

    const lock_wait_minutes = validateNonNegativeNumber(entry.lock_wait_minutes, file, `${rAt}.lock_wait_minutes`, 30);
    const timeout_minutes = validatePositiveNumber(entry.timeout_minutes, file, `${rAt}.timeout_minutes`, 20);
    const build_timeout_minutes = validatePositiveNumber(entry.build_timeout_minutes, file, `${rAt}.build_timeout_minutes`, 60);
    const defaultShotTimeout = validatePositiveNumber(entry.timeout_seconds, file, `${rAt}.timeout_seconds`, 120);
    const min_change = validatePositiveNumber(entry.min_change, file, `${rAt}.min_change`, 4.0);

    const build = entry.build === undefined ? undefined : validateCommandArray(entry.build, file, `${rAt}.build`, BUILD_PLACEHOLDERS);

    let artifact: string | undefined;
    if (entry.artifact !== undefined) {
      if (typeof entry.artifact !== 'string' || !entry.artifact.trim() || entry.artifact.includes('\0')) {
        fail('{file}: "{where}" must be a non-empty file path.', { file, where: `${rAt}.artifact` });
      }
      checkPlaceholders(entry.artifact, BUILD_PLACEHOLDERS, file, `${rAt}.artifact`);
      artifact = entry.artifact.trim();
    }

    let size: [number, number] | undefined;
    if (entry.size !== undefined) {
      if (!Array.isArray(entry.size) || entry.size.length !== 2 || !entry.size.every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) {
        fail('{file}: "{where}" must be [width, height] of positive integers.', { file, where: `${rAt}.size` });
      }
      size = [entry.size[0] as number, entry.size[1] as number];
    }

    const launch = entry.launch === undefined ? undefined : validateCommandArray(entry.launch, file, `${rAt}.launch`, SHOT_PLACEHOLDERS);

    const done = (entry.done ?? 'exit') as CaptureDoneMode;
    if (done !== 'exit' && done !== 'file') {
      fail('{file}: "{where}" must be "exit" or "file".', { file, where: `${rAt}.done` });
    }

    if (!Array.isArray(entry.shots) || !entry.shots.length) {
      fail('{file}: "{where}" must be a non-empty list of shots.', { file, where: `${rAt}.shots` });
    }

    const seenShots = new Set<string>();
    const shots: CaptureShotConfig[] = entry.shots.map((shotRaw, sIndex): CaptureShotConfig => {
      const sAt = `${rAt}.shots[${sIndex}]`;
      if (typeof shotRaw === 'string') {
        fail('{file}: "{where}" must be a shot mapping, never a shell string.', { file, where: sAt });
      }
      if (!isRecord(shotRaw)) fail('{file}: "{where}" must be a mapping.', { file, where: sAt });
      const badShotKeys = Object.keys(shotRaw).filter(k => !(SHOT_KEYS as readonly string[]).includes(k));
      if (badShotKeys.length) {
        fail('{file}: unknown key(s) under "{where}": {keys}.', { file, where: sAt, keys: badShotKeys.map(k => `${sAt}.${k}`).join(', ') });
      }

      if (typeof shotRaw.name !== 'string' || !SHOT_NAME.test(shotRaw.name)) {
        fail('{file}: "{where}" must be a file-safe shot name ([A-Za-z0-9_-]+).', { file, where: `${sAt}.name` });
      }
      if (seenShots.has(shotRaw.name)) {
        fail('{file}: "{where}" duplicates shot name "{name}".', { file, where: `${sAt}.name`, name: shotRaw.name });
      }
      seenShots.add(shotRaw.name);

      const args = shotRaw.args === undefined ? undefined : validateCommandArray(shotRaw.args, file, `${sAt}.args`, SHOT_PLACEHOLDERS, true);
      const command = shotRaw.command === undefined ? undefined : validateCommandArray(shotRaw.command, file, `${sAt}.command`, SHOT_PLACEHOLDERS);
      if (command && args !== undefined) {
        fail('{file}: "{where}" cannot set both "command" and "args".', { file, where: `${sAt}.args` });
      }
      if (!command && !launch) {
        fail('{file}: "{where}" needs either "{launchKey}" or "{cmdKey}".', { file, where: sAt, launchKey: `${rAt}.launch`, cmdKey: `${sAt}.command` });
      }

      const finalCmd = command ?? [...launch!, ...(args ?? [])];
      if (!finalCmd.slice(1).some(a => a.includes('{out}'))) {
        const key = command ? `${sAt}.command` : args !== undefined ? `${sAt}.args` : `${rAt}.launch`;
        fail('{file}: "{where}" for shot "{shot}" must include "{placeholder}" in its final arguments.', { file, where: key, shot: shotRaw.name, placeholder: '{out}' });
      }

      const shotTimeout = validatePositiveNumber(shotRaw.timeout_seconds, file, `${sAt}.timeout_seconds`, defaultShotTimeout);
      let shotDone: CaptureDoneMode | undefined;
      if (shotRaw.done !== undefined) {
        if (shotRaw.done !== 'exit' && shotRaw.done !== 'file') {
          fail('{file}: "{where}" must be "exit" or "file".', { file, where: `${sAt}.done` });
        }
        shotDone = shotRaw.done;
      }

      return {
        name: shotRaw.name,
        ...(args !== undefined ? { args } : {}),
        ...(command !== undefined ? { command } : {}),
        timeout_seconds: shotTimeout,
        ...(shotDone !== undefined ? { done: shotDone } : {}),
      };
    });

    let baseline: string | undefined;
    if (entry.baseline !== undefined) {
      if (typeof entry.baseline !== 'string' || !seenShots.has(entry.baseline)) {
        fail('{file}: "{where}" must name one of the recipe shots ({shots}).', { file, where: `${rAt}.baseline`, shots: [...seenShots].join(', ') });
      }
      baseline = entry.baseline;
    }

    return {
      name: entry.name,
      kinds,
      tags,
      lock,
      lock_wait_minutes,
      timeout_minutes,
      ...(build ? { build } : {}),
      build_timeout_minutes,
      ...(artifact ? { artifact } : {}),
      ...(size ? { size } : {}),
      ...(launch ? { launch } : {}),
      done,
      ...(baseline ? { baseline } : {}),
      min_change,
      shots,
    };
  });

  return { recipes };
}

/** First capture recipe matching the order's effective kind or tags. */
export function matchCaptureRecipe(project: ProjectConfig, doc: OrderDoc): CaptureRecipe | undefined {
  const recipes = project.capture?.recipes;
  if (!recipes?.length) return undefined;
  const traits = orderTraits(project, doc);
  const kind = traits.kind.toLowerCase();
  const tags = traits.tags.map(t => t.toLowerCase());
  return recipes.find(r => (kind !== '' && r.kinds.includes(kind)) || r.tags.some(tag => tags.includes(tag)));
}

export interface CapturePlaceholders {
  tag: string;
  worktree: string;
  out?: string;
  out_dir: string;
  shot?: string;
  revision: string;
  alba: string;
  alba_skills: string;
}

export function expandCaptureString(template: string, vars: CapturePlaceholders): string {
  const map: Record<string, string | undefined> = {
    tag: vars.tag,
    worktree: vars.worktree,
    out: vars.out,
    out_dir: vars.out_dir,
    shot: vars.shot,
    revision: vars.revision,
    alba: vars.alba,
    alba_skills: vars.alba_skills,
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (map[key] !== undefined ? map[key]! : whole));
}

export function expandCaptureCommand(command: readonly string[], vars: CapturePlaceholders): string[] {
  return command.map(arg => expandCaptureString(arg, vars));
}

export function shotFinalTemplate(recipe: CaptureRecipe, shot: CaptureShotConfig): string[] {
  return shot.command ? [...shot.command] : [...recipe.launch!, ...(shot.args ?? [])];
}
