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
} as const;
