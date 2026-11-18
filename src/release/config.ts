import path from 'node:path';
import { fail, releaseText as text, t } from '../i18n.ts';

export const RELEASE_ENGINES = ['unity', 'unreal', 'godot'] as const;
export const RELEASE_TARGETS = ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64', 'web-wasm32'] as const;
export const FINDING_IDS = ['mono-assemblies', 'unencrypted-pak', 'secrets', 'debug-symbols', 'il2cpp-backup',
  'unsigned-pak', 'godot-unencrypted-pck', 'pak-unreadable', 'web-build'] as const;
const DEFAULT_FAILURES = FINDING_IDS.slice(0, 5);
const BACKENDS = ['il2cpp', 'mono'] as const;
const STRIPPING = ['high', 'medium', 'low', 'minimal'] as const;
const CONFIGURATIONS = ['Shipping', 'Development'] as const;
export type ReleaseEngine = typeof RELEASE_ENGINES[number];
export type ReleaseTarget = typeof RELEASE_TARGETS[number];
export type FindingId = typeof FINDING_IDS[number];

export interface AuditPolicy {
  fail_on: FindingId[];
  allow: { id: FindingId; reason: string }[];
  extra_secret_patterns: string[];
}

export interface ReleaseConfig {
  output: string;
  version?: string;
  targets: ReleaseTarget[];
  unity: { editor?: string; scripting_backend: typeof BACKENDS[number]; stripping: typeof STRIPPING[number]; build_method?: string };
  unreal: { engine_root?: string; configuration: typeof CONFIGURATIONS[number]; encrypt_pak: boolean; sign_pak: boolean };
  godot: { executable?: string; preset?: string | Partial<Record<ReleaseTarget, string>>; encryption_key_env?: string };
  audit: AuditPolicy;
  vesper?: { app_id: string };
}

type Validation = (key: string, expected: string) => never;
type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value);
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const validVersion = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) &&
  !value.endsWith('.') && !windowsDevice.test(value);
export const isReleaseTarget = (value: string): value is ReleaseTarget => RELEASE_TARGETS.some(target => target === value);
export const isReleaseEngine = (value: string): value is ReleaseEngine => RELEASE_ENGINES.some(engine => engine === value);

function mapping(value: unknown, at: string, keys: readonly string[], invalid: Validation): Mapping {
  if (!isMapping(value)) return invalid(at, text.mapping);
  for (const key of Object.keys(value)) {
    const field = at ? `${at}.${key}` : key;
    if (/(?:^|_)(?:key|token|secret)$/i.test(key)) invalid(field, text.literal);
    if (!keys.includes(key)) invalid(field, text.unknown);
  }
  return value;
}

function item<T extends string>(value: unknown, choices: readonly T[], at: string, invalid: Validation): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(at, choices.join(', '));
  return value as T;
}

function list(value: unknown, at: string, invalid: Validation): unknown[] {
  if (!Array.isArray(value)) return invalid(at, text.list);
  return value;
}

function string(value: unknown, at: string, invalid: Validation): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) return invalid(at, text.string);
  return value.trim();
}

function flag(value: unknown, at: string, invalid: Validation): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') return invalid(at, text.boolean);
  return value;
}

function auditPolicy(value: unknown, invalid: Validation): AuditPolicy {
  const raw = mapping(value, 'audit', ['fail_on', 'allow', 'extra_secret_patterns'], invalid);
  const fail_on = list(raw.fail_on === undefined ? DEFAULT_FAILURES : raw.fail_on, 'audit.fail_on', invalid)
    .map((id, i) => item(id, FINDING_IDS, `audit.fail_on[${i}]`, invalid));
  const allow = list(raw.allow === undefined ? [] : raw.allow, 'audit.allow', invalid).map((entry, i) => {
    const at = `audit.allow[${i}]`;
    const row = mapping(entry, at, ['id', 'reason'], invalid);
    return { id: item(row.id, FINDING_IDS, `${at}.id`, invalid), reason: string(row.reason, `${at}.reason`, invalid) };
  });
  const extra_secret_patterns = list(raw.extra_secret_patterns === undefined ? [] : raw.extra_secret_patterns, 'audit.extra_secret_patterns', invalid)
    .map((entry, i) => {
      const at = `audit.extra_secret_patterns[${i}]`;
      if (typeof entry !== 'string' || !entry.trim()) return invalid(at, text.regex);
      try { new RegExp(entry, 'u'); } catch { invalid(at, text.regex); }
      return entry;
    });
  return { fail_on, allow, extra_secret_patterns };
}

export function validateRelease(value: unknown, file: string): ReleaseConfig {
  const invalid: Validation = (key, expected) => fail(text.config, { file, key: key ? `release.${key}` : 'release', expected: t(expected) });
  const raw = mapping(value, '', ['output', 'version', 'targets', 'unity', 'unreal', 'godot', 'audit', 'vesper'], invalid);
  const optional = (value: unknown, at: string) => value === undefined ? undefined : string(value, at, invalid);
  const block = (key: string, keys: string[]) => mapping(raw[key] === undefined ? {} : raw[key], key, keys, invalid);
  const output = optional(raw.output, 'output') ?? 'builds/release';
  if (path.posix.isAbsolute(output) || path.win32.parse(output).root || output.split(/[/\\]/).some(part =>
    part !== '.' && (/[<>:"|?*]|[ .]$/.test(part) || windowsDevice.test(part)))) {
    invalid('output', text.output);
  }
  const version = optional(raw.version, 'version');
  if (version !== undefined && !validVersion(version)) invalid('version', text.version);
  const targets = list(raw.targets === undefined ? [] : raw.targets, 'targets', invalid)
    .map((target, i) => item(target, RELEASE_TARGETS, `targets[${i}]`, invalid));
  const u = block('unity', ['editor', 'scripting_backend', 'stripping', 'build_method']);
  const ue = block('unreal', ['engine_root', 'configuration', 'encrypt_pak', 'sign_pak']);
  const g = block('godot', ['executable', 'preset', 'encryption_key_env']);
  const encryption_key_env = optional(g.encryption_key_env, 'godot.encryption_key_env');
  if (encryption_key_env && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(encryption_key_env) || /^[a-f\d]{64}$/i.test(encryption_key_env))) {
    invalid('godot.encryption_key_env', text.envName);
  }
  const preset = isMapping(g.preset)
    ? Object.fromEntries(Object.entries(mapping(g.preset, 'godot.preset', RELEASE_TARGETS, invalid))
      .map(([key, value]) => [key, string(value, `godot.preset.${key}`, invalid)]))
    : optional(g.preset, 'godot.preset');
  const vesper = raw.vesper === undefined ? undefined : block('vesper', ['app_id']);
  return {
    output, version, targets: [...new Set(targets)],
    unity: {
      editor: optional(u.editor, 'unity.editor'), build_method: optional(u.build_method, 'unity.build_method'),
      scripting_backend: item(u.scripting_backend === undefined ? 'il2cpp' : u.scripting_backend, BACKENDS, 'unity.scripting_backend', invalid),
      stripping: item(u.stripping === undefined ? 'high' : u.stripping, STRIPPING, 'unity.stripping', invalid),
    },
    unreal: {
      engine_root: optional(ue.engine_root, 'unreal.engine_root'),
      configuration: item(ue.configuration === undefined ? 'Shipping' : ue.configuration, CONFIGURATIONS, 'unreal.configuration', invalid),
      encrypt_pak: flag(ue.encrypt_pak, 'unreal.encrypt_pak', invalid), sign_pak: flag(ue.sign_pak, 'unreal.sign_pak', invalid),
    },
    godot: { executable: optional(g.executable, 'godot.executable'), preset, encryption_key_env },
    audit: auditPolicy(raw.audit === undefined ? {} : raw.audit, invalid),
    vesper: vesper && { app_id: string(vesper.app_id, 'vesper.app_id', invalid) },
  };
}
