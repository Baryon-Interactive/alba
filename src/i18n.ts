// All user-facing text goes through t(). The English text is the key; a catalog for another language
// (src/i18n-zh.ts) is looked up by it, so call sites never change. The language is the one of the request when the
// interface sets it (withLang), else ALBA_LANG, else English.
import { AsyncLocalStorage } from 'node:async_hooks';
import { zh } from './i18n-zh.ts';

export type Lang = 'en' | 'zh';

const catalogs: Record<string, Record<string, string>> = { zh };
const store = new AsyncLocalStorage<Lang>();

/** What a caller that states no preference gets: `ALBA_LANG` (`zh`, `zh-CN`, ...) or English. */
export const defaultLang = (): Lang => (/^zh/i.test(process.env.ALBA_LANG ?? '') ? 'zh' : 'en');
export const currentLang = (): Lang => store.getStore() ?? defaultLang();
/** Runs `fn` (and what it awaits) with texts in `lang`. */
export const withLang = <T>(lang: Lang, fn: () => T): T => store.run(lang, fn);

const fill = (template: string, vars: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));

export function t(text: string, vars: Record<string, string | number> = {}): string {
  return translate(currentLang(), text, vars);
}

/** An error whose message is meant for the person at the keyboard (no stack trace). `english` is the same message in English, which code can recognise whatever language the person reads. */
export class UserError extends Error {
  readonly english: string;
  constructor(message: string, english: string = message) { super(message); this.english = english; }
}

export function fail(text: string, vars: Record<string, string | number> = {}): never {
  throw new UserError(t(text, vars), fill(text, vars));
}

/** Translate an explicit language without changing the request context. */
export function translate(lang: Lang, text: string, vars: Record<string, string | number> = {}): string {
  return fill(catalogs[lang]?.[text] ?? text, vars);
}

export { textConventions, localizedVague } from './i18n-zh.ts';

type ReleaseFields<Keys extends string> = Record<Keys, string | number>;

export const releaseText = {
  config: (vars: ReleaseFields<'file' | 'key' | 'expected'>) => fail('{file}: "{key}" expects {expected}.', vars),
  mapping: () => t('a mapping'),
  list: () => t('a list'),
  string: () => t('a non-empty single-line string'),
  boolean: () => t('true or false'),
  unknown: () => t('a known release key (unknown key)'),
  literal: () => t('an environment variable reference (literal secrets are forbidden)'),
  regex: () => t('a valid non-empty regular expression'),
  output: () => t('a relative output path inside the project'),
  version: () => t('a portable version label such as 1.2.0'),
  envName: () => t('an environment variable name (literal secrets are forbidden)'),
  webBackend: () => t('Unity WebGL always uses IL2CPP.'),
  unsupportedTarget: (vars: ReleaseFields<'engine' | 'target'>) => fail('{engine} does not support release target {target}.', vars),
  uproject: (vars: ReleaseFields<'dir'>) => fail('Expected exactly one .uproject at {dir}.', vars),
  cryptoRead: (vars: ReleaseFields<'file'>) => fail('Could not read {file}. Check Project Settings > Crypto.', vars),
  cryptoEncryption: (vars: ReleaseFields<'file'>) => fail('{file}: Enable pak encryption and configure an encryption key in Project Settings > Crypto.', vars),
  cryptoSigning: (vars: ReleaseFields<'file'>) => fail('{file}: Enable pak signing and configure the signing keys in Project Settings > Crypto.', vars),
  godotPreset: (vars: ReleaseFields<'target'>) => fail('Set release.godot.preset for {target}.', vars),
  godotTemplates: () => t('Encrypted Godot exports need export templates built with the configured key.'),
  engineTool: (vars: ReleaseFields<'engine' | 'key'>) => fail('Could not find the {engine} build tool. Set {key}.', vars),
  godotKey: (vars: ReleaseFields<'name'>) => fail('Set {name} to a 64-digit hexadecimal Godot encryption key.', vars),
  batchArgument: () => fail('Windows batch files cannot be run with quotes, percent signs or line breaks in release arguments.'),
  launchFailed: (vars: ReleaseFields<'command'>) => t('Could not start {command}.', vars),
  unsafeFolder: (vars: ReleaseFields<'dir'>) => fail('Release path must be a regular path inside the project: {dir}', vars),
  templateChanged: (vars: ReleaseFields<'file'>) => fail('{file} has changed. Pass --force to replace it.', vars),
  auditMono: () => t('Build with IL2CPP to avoid shipping game DLLs. IL2CPP still ships global-metadata.dat, which dumpers can read unless it is obfuscated.'),
  auditBackup: () => t('Remove Unity backup and Burst debug information folders from the shipping build.'),
  auditSymbols: () => t('Keep debug symbols and debug manifests in private symbol storage.'),
  auditPak: () => t('Enable pak index and IoStore encryption in Project Settings > Crypto, then rebuild.'),
  auditUnreadable: () => t('Verify the Unreal archive with the matching Unreal Engine tools.'),
  auditSignature: () => t('Enable signing in Project Settings > Crypto and ship the matching .sig file.'),
  auditGodot: () => t('Enable PCK directory encryption in the Godot export preset and use templates built with the key.'),
  auditSecrets: () => t('Remove secret-bearing files and rotate any exposed credential before distribution.'),
  auditWeb: () => t('Assets and IL2CPP metadata can be extracted from a WebGL data file. Obfuscation can raise the effort.'),
  auditFolder: (vars: ReleaseFields<'dir'>) => fail('Could not read the build folder: {dir}', vars),
  auditFile: (vars: ReleaseFields<'file'>) => fail('Could not audit file: {file}', vars),
  auditFailed: (vars: ReleaseFields<'dir'>) => t('Could not complete the release audit: {dir}', vars),
  existingRelease: (vars: ReleaseFields<'dir'>) => fail('Release folder already exists: {dir}. Use a new version or move the existing release.', vars),
  outputFailed: (vars: ReleaseFields<'dir'>) => t('Could not create the release folder: {dir}', vars),
  skipAudit: (vars: ReleaseFields<'target'>) => t('Warning: Release audit skipped for {target}.', vars),
  buildLogFailed: (vars: ReleaseFields<'file'>) => t('Could not complete the build log: {file}', vars),
  releaseReport: (vars: ReleaseFields<'target' | 'exit' | 'file'>) => t('{target}: engine exit {exit}. Release report: {file}', vars),
  vesperMissing: () => t('Could not find vesper on PATH.'),
  vesperResult: (vars: ReleaseFields<'target' | 'exit' | 'file'>) => t('{target}: vesper pack exit {exit}. Log: {file}', vars),
  auditSummary: (vars: ReleaseFields<'fail' | 'warn'>) => t('Release audit: {fail} failed, {warn} warned.', vars),
  auditFail: () => t('fail'),
  auditWarn: () => t('warn'),
  auditAllowed: (vars: ReleaseFields<'reason'>) => t('Allowed: {reason}', vars),
  helpPlan: () => t('release plan [--target <target>]... [--version <version>]   print engine commands'),
  helpBuild: () => t('release build [--target <target>]... [--version <version>] [--skip-audit] [--dry-run] [--vesper-pack]'),
  helpAudit: () => t('release audit <dir> [--engine unity|unreal|godot] [--json]   audit a build folder'),
  helpInit: () => t('release init-unity [--force]   install the Unity editor build script'),
  releaseUsage: () => fail('Usage: alba release plan | build | audit <dir> | init-unity. Run alba release --help for options.'),
  releaseFlag: (vars: ReleaseFields<'flag' | 'command'>) => fail('--{flag} is not an option for release {command}.', vars),
  releaseEngineOption: () => fail('--engine must be unity, unreal or godot.'),
  releaseEngine: (vars: ReleaseFields<'file'>) => fail('{file}: Set engine to unity, unreal or godot to package releases.', vars),
  releaseVersion: (vars: ReleaseFields<'expected'>) => fail('--version expects {expected}.', vars),
  releaseTarget: (vars: ReleaseFields<'targets'>) => fail('--target must be one of: {targets}.', vars),
  noReleaseTargets: () => fail('Set release.targets or pass --target.'),
  noVesperConfig: () => fail('Set release.vesper.app_id to use --vesper-pack.'),
  templateReady: (vars: ReleaseFields<'file'>) => t('Unity release build script ready at {file}.', vars),
} as const;
