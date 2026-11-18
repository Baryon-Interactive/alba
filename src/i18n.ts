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

export const releaseText = {
  config: '{file}: "{key}" expects {expected}.',
  mapping: 'a mapping',
  list: 'a list',
  string: 'a non-empty single-line string',
  boolean: 'true or false',
  unknown: 'a known release key (unknown key)',
  literal: 'an environment variable reference (literal secrets are forbidden)',
  regex: 'a valid non-empty regular expression',
  output: 'a relative output path inside the project',
  version: 'a portable version label such as 1.2.0',
  envName: 'an environment variable name (literal secrets are forbidden)',
  webBackend: 'Unity WebGL always uses IL2CPP.',
  unsupportedTarget: '{engine} does not support release target {target}.',
  uproject: 'Expected exactly one .uproject at {dir}.',
  cryptoRead: 'Could not read {file}. Check Project Settings > Crypto.',
  cryptoEncryption: '{file}: Enable pak encryption and configure an encryption key in Project Settings > Crypto.',
  cryptoSigning: '{file}: Enable pak signing and configure the signing keys in Project Settings > Crypto.',
  godotPreset: 'Set release.godot.preset for {target}.',
  godotTemplates: 'Encrypted Godot exports need export templates built with the configured key.',
  engineTool: 'Could not find the {engine} build tool. Set {key}.',
  godotKey: 'Set {name} to a 64-digit hexadecimal Godot encryption key.',
  batchArgument: 'Windows batch files cannot be run with quotes, percent signs or line breaks in release arguments.',
  launchFailed: 'Could not start {command}.',
  unsafeFolder: 'Release path must be a regular path inside the project: {dir}',
  templateChanged: '{file} has changed. Pass --force to replace it.',
  auditMono: 'Build with IL2CPP to avoid shipping game DLLs. IL2CPP still ships global-metadata.dat, which dumpers can read unless it is obfuscated.',
  auditBackup: 'Remove Unity backup and Burst debug information folders from the shipping build.',
  auditSymbols: 'Keep debug symbols and debug manifests in private symbol storage.',
  auditPak: 'Enable pak index and IoStore encryption in Project Settings > Crypto, then rebuild.',
  auditUnreadable: 'Verify the Unreal archive with the matching Unreal Engine tools.',
  auditSignature: 'Enable signing in Project Settings > Crypto and ship the matching .sig file.',
  auditGodot: 'Enable PCK directory encryption in the Godot export preset and use templates built with the key.',
  auditSecrets: 'Remove secret-bearing files and rotate any exposed credential before distribution.',
  auditWeb: 'Assets and IL2CPP metadata can be extracted from a WebGL data file. Obfuscation can raise the effort.',
  auditFolder: 'Could not read the build folder: {dir}',
  auditFile: 'Could not audit file: {file}',
  existingRelease: 'Release folder already exists: {dir}. Use a new version or move the existing release.',
  outputFailed: 'Could not create the release folder: {dir}',
  skipAudit: 'Warning: Release audit skipped for {target}.',
  buildLogFailed: 'Could not complete the build log: {file}',
  releaseReport: '{target}: engine exit {exit}. Release report: {file}',
  vesperMissing: 'Could not find vesper on PATH.',
  vesperResult: '{target}: vesper pack exit {exit}. Log: {file}',
  auditSummary: 'Release audit: {fail} failed, {warn} warned.',
  auditFail: 'fail',
  auditWarn: 'warn',
  auditAllowed: 'Allowed: {reason}',
  helpPlan: 'release plan [--target <target>]... [--version <version>]   print engine commands',
  helpBuild: 'release build [--target <target>]... [--version <version>] [--skip-audit] [--dry-run] [--vesper-pack]',
  helpAudit: 'release audit <dir> [--engine unity|unreal|godot] [--json]   audit a build folder',
  helpInit: 'release init-unity [--force]   install the Unity editor build script',
  releaseUsage: 'Usage: alba release plan | build | audit <dir> | init-unity. Run alba release --help for options.',
  releaseFlag: '--{flag} is not an option for release {command}.',
  releaseEngineOption: '--engine must be unity, unreal or godot.',
  releaseEngine: '{file}: Set engine to unity, unreal or godot to package releases.',
  releaseVersion: '--version expects {expected}.',
  releaseTarget: '--target must be one of: {targets}.',
  noReleaseTargets: 'Set release.targets or pass --target.',
  noVesperConfig: 'Set release.vesper.app_id to use --vesper-pack.',
  templateReady: 'Unity release build script ready at {file}.',
} as const;
