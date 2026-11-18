import path from 'node:path';
import { fail, t, releaseText as text } from '../i18n.ts';
import type { BuildCommand, BuildLocation } from './build.ts';
import type { ReleaseConfig, ReleaseTarget } from './config.ts';

const extensions: Record<ReleaseTarget, string> = {
  'windows-x64': '.exe', 'linux-x64': '.x86_64', 'macos-arm64': '.app', 'macos-x64': '.app', 'web-wasm32': '.html',
};

export function godotBuild(location: BuildLocation, config: ReleaseConfig['godot'], target: ReleaseTarget,
  command: string, name: string): BuildCommand {
  const preset = typeof config.preset === 'string' ? config.preset : config.preset?.[target];
  if (!preset) fail(text.godotPreset, { target });
  const key = config.encryption_key_env;
  return { ...location, command, args: ['--headless', '--export-release', preset, path.join(location.outputDir, name + extensions[target])],
    env: key ? { GODOT_SCRIPT_ENCRYPTION_KEY: key } : {}, hardening: { preset, ...(key && { encryption_key_env: key }) },
    notices: key ? [t(text.godotTemplates)] : [] };
}
