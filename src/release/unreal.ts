import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail, releaseText as text } from '../i18n.ts';
import type { BuildCommand, BuildLocation, BuildTools } from './build.ts';
import type { ReleaseConfig, ReleaseTarget } from './config.ts';

export function unrealBuild(location: BuildLocation, config: ReleaseConfig['unreal'], target: ReleaseTarget,
  tools: BuildTools): BuildCommand {
  if (target === 'web-wasm32') fail(text.unsupportedTarget, { engine: 'unreal', target });
  if (!tools.projectFile) fail(text.uproject, { dir: location.cwd });
  const platform = target === 'windows-x64' ? 'Win64' : target === 'linux-x64' ? 'Linux' : 'Mac';
  const args = ['BuildCookRun', `-project=${tools.projectFile}`, `-platform=${platform}`, `-clientconfig=${config.configuration}`,
    '-build', '-cook', '-stage', '-pak', '-iostore', '-package', '-archive', `-archivedirectory=${location.outputDir}`,
    '-nodebuginfo', '-utf8output'];
  if (platform === 'Mac') args.push(`-specifiedarchitecture=${target === 'macos-arm64' ? 'arm64' : 'x86_64'}`);
  const { configuration, encrypt_pak, sign_pak } = config;
  return { ...location, command: tools.command, args, env: {}, hardening: { configuration, encrypt_pak, sign_pak }, notices: [] };
}

const signingFields = ['signingmodulus', 'signingprivateexponent', 'signingpublicexponent'];
const encryptionFlags = ['benablepakindexencryption', 'bencryptallassetfiles', 'bencryptpakinifiles'];

/** Read key material exclusively for preflight validation and log redaction. */
export function unrealCrypto(root: string, config: ReleaseConfig['unreal']): string[] {
  const ini = path.join(root, 'Config', 'DefaultCrypto.ini');
  const settings = new Map<string, string>();
  let crypto = false;
  try {
    for (const raw of readFileSync(ini, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) crypto = /^\[\/script\/cryptokeys\.cryptokeyssettings\]$/i.test(line);
      const entry = /^(\w+)\s*=\s*(.*)$/.exec(line);
      if (crypto && entry) settings.set(entry[1].toLowerCase(), entry[2].trim().replace(/^"(.*)"$/, '$1'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(text.cryptoRead, { file: ini });
  }
  const on = (name: string) => /^true$/i.test(settings.get(name) ?? '');
  if (config.encrypt_pak && (!encryptionFlags.some(on) || !settings.get('encryptionkey'))) fail(text.cryptoEncryption, { file: ini });
  if (config.sign_pak && (!on('benablepaksigning') || !signingFields.every(name => settings.get(name)))) fail(text.cryptoSigning, { file: ini });
  return ['encryptionkey', ...signingFields].flatMap(name => settings.get(name) || []);
}
