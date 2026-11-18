import path from 'node:path';
import { t, releaseText as text } from '../i18n.ts';
import type { BuildCommand, BuildLocation } from './build.ts';
import type { ReleaseConfig, ReleaseTarget } from './config.ts';

export const UNITY_METHOD = 'Alba.Release.AlbaReleaseBuild.Build';

const targets: Record<ReleaseTarget, [string, string]> = {
  'windows-x64': ['Win64', '.exe'],
  'linux-x64': ['Linux64', '.x86_64'],
  'macos-arm64': ['OSXUniversal', '.app'],
  'macos-x64': ['OSXUniversal', '.app'],
  'web-wasm32': ['WebGL', ''],
};

export function unityBuild(location: BuildLocation, config: ReleaseConfig['unity'], target: ReleaseTarget,
  command: string, name: string): BuildCommand {
  const [platform, ext] = targets[target];
  const web = target === 'web-wasm32';
  const backend = web ? 'il2cpp' : config.scripting_backend;
  const output = web ? location.outputDir : path.join(location.outputDir, name + ext);
  const args = ['-batchmode', '-nographics', '-quit', '-projectPath', location.cwd, '-buildTarget', platform,
    '-executeMethod', config.build_method ?? UNITY_METHOD, '-logFile', location.logFile,
    '-albaTarget', target, '-albaOutput', output, '-albaStripping', config.stripping];
  if (!web) args.push('-albaBackend', backend);
  return { ...location, command, args, env: {}, hardening: { backend, stripping: config.stripping },
    notices: web ? [t(text.webBackend)] : [] };
}
