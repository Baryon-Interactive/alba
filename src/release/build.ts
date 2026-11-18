import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { ReleaseConfig, ReleaseEngine, ReleaseTarget } from './config.ts';
import { godotBuild } from './godot.ts';
import { unityBuild } from './unity.ts';
import { unrealBuild } from './unreal.ts';

export type BuildProject = Pick<ProjectConfig, 'id' | 'name' | 'root'>;
export interface BuildLocation {
  cwd: string;
  logFile: string;
  outputDir: string;
}
export interface BuildCommand extends BuildLocation {
  command: string;
  args: string[];
  /** Child variable names mapped to source variable names. Values are resolved only at launch. */
  env: Record<string, string>;
  hardening: Record<string, string | boolean>;
  notices: (() => string)[];
}
export interface BuildTools { command: string; projectFile?: string }

export function buildLocation(root: string, output: string, version: string, target: ReleaseTarget): BuildLocation {
  const targetDir = path.join(root, ...output.split(/[/\\]/), version, target);
  return { cwd: root, logFile: path.join(targetDir, 'build.log'), outputDir: path.join(targetDir, 'game') };
}

export function buildCommand(project: BuildProject, config: ReleaseConfig, engine: ReleaseEngine,
  target: ReleaseTarget, version: string, tools: BuildTools): BuildCommand {
  const location = buildLocation(project.root, config.output, version, target);
  const name = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[ .]+$/, '');
  const safeName = !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `${project.id}-game` : name;
  if (engine === 'unity') return unityBuild(location, config.unity, target, tools.command, safeName);
  if (engine === 'unreal') return unrealBuild(location, config.unreal, target, tools);
  return godotBuild(location, config.godot, target, tools.command, safeName);
}

export function publicCommand({ command, args, env, cwd }: BuildCommand) {
  return { command, args, env: Object.fromEntries(Object.entries(env).map(([key, source]) => [key, `<from $${source}>`])), cwd };
}
