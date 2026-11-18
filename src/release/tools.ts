import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail, releaseText as text } from '../i18n.ts';
import { posixSystemPath } from '../machines/commands.ts';
import type { BuildProject, BuildTools } from './build.ts';
import type { ReleaseConfig, ReleaseEngine } from './config.ts';

const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const byVersion = (a: string, b: string) => b.localeCompare(a, 'en', { numeric: true });

function entries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function configuredCommand(root: string, value: string): string {
  return /[/\\]/.test(value) ? path.resolve(root, value) : value;
}

function unityEditor(root: string): string | undefined {
  const home = homedir();
  const roots = windows ? [path.join(process.env.ProgramFiles ?? '', 'Unity', 'Hub', 'Editor')]
    : mac ? ['/Applications/Unity/Hub/Editor'] : [path.join(home, 'Unity/Hub/Editor'), posixSystemPath('opt', 'unity', 'Hub', 'Editor')];
  const binary = windows ? 'Editor/Unity.exe' : mac ? 'Unity.app/Contents/MacOS/Unity' : 'Editor/Unity';
  const builds = roots.flatMap(dir => entries(dir).map(version => ({ version, command: path.join(dir, version, binary) })));
  const version = /(?:^|\n)m_EditorVersion:\s*(\S+)/.exec(
    optionalFile(path.join(root, 'ProjectSettings', 'ProjectVersion.txt')) ?? '')?.[1];
  const available = builds.filter(build => existsSync(build.command));
  return available.find(build => build.version === version)?.command ?? available.sort((a, b) => byVersion(a.version, b.version))[0]?.command;
}

const runUat = (root: string) => path.join(root, 'Engine', 'Build', 'BatchFiles', windows ? 'RunUAT.bat' : 'RunUAT.sh');

function registeredUnreal(): string[] {
  if (!windows) return [];
  try {
    const result = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine', '/s', '/v', 'InstalledDirectory'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return [...result.matchAll(/^\s*InstalledDirectory\s+REG_\w+\s+(.+)$/gm)].map(row => row[1].trim());
  } catch { return []; }
}

function optionalFile(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function unrealVersion(root: string): string {
  const content = optionalFile(path.join(root, 'Engine/Build/Build.version'));
  if (content) {
    try {
      const { MajorVersion, MinorVersion, PatchVersion } = JSON.parse(content.replace(/^\uFEFF/, ''));
      if ([MajorVersion, MinorVersion, PatchVersion].every(Number.isInteger)) return `${MajorVersion}.${MinorVersion}.${PatchVersion}`;
    } catch { /* Fall back to the installation folder name. */ }
  }
  return /\d+(?:\.\d+)*/.exec(path.basename(root))?.[0] ?? '0';
}

function newestUnreal(): string | undefined {
  const roots = windows ? [path.join(process.env.ProgramFiles ?? '', 'Epic Games')]
    : mac ? [posixSystemPath('Users', 'Shared', 'Epic Games'), '/Applications']
      : [homedir(), posixSystemPath('opt'), posixSystemPath('opt', 'UnrealEngine')];
  const installs = [...registeredUnreal(), ...roots.flatMap(dir => entries(dir)
    .filter(name => /^(?:UE_|UnrealEngine)/.test(name)).map(name => path.join(dir, name)))];
  return installs.filter(root => existsSync(runUat(root))).map(root => ({ root, version: unrealVersion(root) }))
    .sort((a, b) => byVersion(a.version, b.version))[0]?.root;
}

/** Find commands on PATH without running them or searching the working directory. */
export function onPath(command: string): string | undefined {
  const extensions = windows ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(part => path.isAbsolute(part))) {
    for (const ext of extensions) {
      const file = path.join(dir, command + ext);
      try {
        accessSync(file, constants.X_OK);
        if (statSync(file).isFile()) return file;
      } catch { /* Try the next PATH entry. */ }
    }
  }
}

export function resolveBuildTools(project: BuildProject, config: ReleaseConfig, engine: ReleaseEngine): BuildTools {
  const { root } = project;
  if (engine === 'unity') {
    const command = config.unity.editor ? configuredCommand(root, config.unity.editor) : unityEditor(root);
    if (!command) fail(text.engineTool, { engine, key: 'release.unity.editor' });
    return { command };
  }
  if (engine === 'godot') {
    const command = config.godot.executable ? configuredCommand(root, config.godot.executable) : onPath('godot') ?? onPath('godot4') ?? 'godot';
    return { command };
  }
  const projects = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && /\.uproject$/i.test(entry.name));
  if (projects.length !== 1) fail(text.uproject, { dir: root });
  const engineRoot = config.unreal.engine_root ? path.resolve(root, config.unreal.engine_root) : newestUnreal();
  if (!engineRoot || !existsSync(runUat(engineRoot))) fail(text.engineTool, { engine, key: 'release.unreal.engine_root' });
  return { command: runUat(engineRoot), projectFile: path.join(root, projects[0].name) };
}
