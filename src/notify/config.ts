import { fail } from '../i18n.ts';

export const TRIGGER_NAMES = [
  'review-waiting',
  'question-waiting',
  'worker-paused',
  'quota-unreadable',
  'run-stalled',
  'machine-down',
  'serve-crashed',
] as const;

export type TriggerName = (typeof TRIGGER_NAMES)[number];

export const DEFAULT_TRIGGER_MINUTES: Record<TriggerName, number> = {
  'review-waiting': 120,
  'question-waiting': 30,
  'worker-paused': 0,
  'quota-unreadable': 20,
  'run-stalled': 0,
  'machine-down': 10,
  'serve-crashed': 0,
};

export interface WebhookChannelConfig {
  type: 'webhook' | 'ntfy';
  url_env: string;
  token_env?: string;
}

export interface SlackChannelConfig {
  type: 'slack';
  url_env: string;
}

export interface WindowsToastChannelConfig {
  type: 'windows-toast';
}

export type NotifyChannelConfig = WebhookChannelConfig | SlackChannelConfig | WindowsToastChannelConfig;

export interface QuietHoursConfig {
  from: string;
  to: string;
  except: TriggerName[];
}

export interface DigestConfig {
  at: string;
  to: string[];
}

export interface TriggerConfig {
  after_minutes: number;
  off: boolean;
  to?: string[];
  projects?: string[];
}

export interface NotifyConfig {
  channels: Record<string, NotifyChannelConfig>;
  to: string[];
  quiet_hours?: QuietHoursConfig;
  digest?: DigestConfig;
  triggers: Record<TriggerName, TriggerConfig>;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CLOCK_HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkForbiddenInlineSecrets(raw: Record<string, unknown>, where: string): void {
  if ('url' in raw || 'webhook' in raw) {
    const key = 'url' in raw ? 'url' : 'webhook';
    fail('{where}: "{key}" may not hold a value; pass an environment variable name in "url_env" instead.', { where, key });
  }
  if ('token' in raw) {
    fail('{where}: "token" may not hold a value; pass an environment variable name in "token_env" instead.', { where });
  }
}

function validateEnvName(value: unknown, key: string, where: string): string {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    fail('{where}: "{key}" must be an environment variable name matching [A-Z_][A-Z0-9_]*.', { where, key });
  }
  return value;
}

function validateTimeHm(value: unknown, key: string, where: string): string {
  if (typeof value !== 'string' || !CLOCK_HM.test(value)) {
    fail('{where}: "{key}" must be a 24-hour local time HH:MM.', { where, key });
  }
  return value;
}

function validateChannelRefs(value: unknown, channels: Record<string, NotifyChannelConfig>, where: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    fail('{where} must be a list of channel ids.', { where });
  }
  const known = Object.keys(channels);
  const result: string[] = [];
  for (const raw of value as string[]) {
    const id = raw.trim();
    if (!channels[id]) fail('{where}: unknown channel "{channel}" (known: {known}).', { where, channel: id, known: known.join(', ') });
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function validateChannel(raw: unknown, where: string): NotifyChannelConfig {
  if (!isRecord(raw)) fail('{where} must be a mapping.', { where });
  checkForbiddenInlineSecrets(raw, where);
  if (raw.type === 'webhook' || raw.type === 'ntfy') {
    const unknown = Object.keys(raw).filter(k => !['type', 'url_env', 'token_env'].includes(k));
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    const url_env = validateEnvName(raw.url_env, 'url_env', where);
    const token_env = raw.token_env === undefined ? undefined : validateEnvName(raw.token_env, 'token_env', where);
    return { type: raw.type, url_env, ...(token_env ? { token_env } : {}) };
  }
  if (raw.type === 'slack') {
    const unknown = Object.keys(raw).filter(k => !['type', 'url_env'].includes(k));
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    return { type: 'slack', url_env: validateEnvName(raw.url_env, 'url_env', where) };
  }
  if (raw.type === 'windows-toast') {
    const unknown = Object.keys(raw).filter(k => k !== 'type');
    if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
    return { type: 'windows-toast' };
  }
  return fail('{where}: "type" must be "webhook", "ntfy", "slack" or "windows-toast".', { where });
}

function validateTrigger(name: TriggerName, raw: unknown, channels: Record<string, NotifyChannelConfig>, where: string): TriggerConfig {
  if (!isRecord(raw)) fail('{where} must be a mapping.', { where });
  checkForbiddenInlineSecrets(raw, where);
  const unknown = Object.keys(raw).filter(k => !['after_minutes', 'off', 'to', 'projects'].includes(k));
  if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
  let after_minutes = DEFAULT_TRIGGER_MINUTES[name];
  if (raw.after_minutes !== undefined) {
    if (typeof raw.after_minutes !== 'number' || !Number.isFinite(raw.after_minutes) || raw.after_minutes < 0) {
      fail('{where}: "after_minutes" must be a number >= 0.', { where });
    }
    after_minutes = raw.after_minutes;
  }
  let off = false;
  if (raw.off !== undefined) {
    if (typeof raw.off !== 'boolean') fail('{where}: "off" must be true or false.', { where });
    off = raw.off;
  }
  const to = raw.to === undefined ? undefined : validateChannelRefs(raw.to, channels, `${where}.to`);
  let projects: string[] | undefined;
  if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects) || raw.projects.some(p => typeof p !== 'string' || !p.trim())) {
      fail('{where}: "projects" must be a list of non-empty project ids.', { where });
    }
    projects = [...new Set((raw.projects as string[]).map(p => p.trim()))];
  }
  return {
    after_minutes,
    off,
    ...(to !== undefined ? { to } : {}),
    ...(projects !== undefined ? { projects } : {}),
  };
}

export function validateNotify(raw: unknown, where: string): NotifyConfig {
  if (!isRecord(raw)) fail('{where} must be a mapping.', { where });
  checkForbiddenInlineSecrets(raw, where);
  const unknown = Object.keys(raw).filter(k => !['channels', 'to', 'quiet_hours', 'digest', 'triggers'].includes(k));
  if (unknown.length) fail('{where}: unknown key(s): {keys}.', { where, keys: unknown.join(', ') });
  if (!isRecord(raw.channels) || !Object.keys(raw.channels).length) {
    fail('{where}: "channels" must be a non-empty mapping.', { where });
  }
  const channels: Record<string, NotifyChannelConfig> = {};
  for (const [id, value] of Object.entries(raw.channels)) {
    if (!CHANNEL_ID.test(id)) fail('{where}: invalid channel id "{id}".', { where: `${where}.channels`, id });
    channels[id] = validateChannel(value, `${where}.channels.${id}`);
  }
  const to = raw.to === undefined ? [] : validateChannelRefs(raw.to, channels, `${where}.to`);

  let quiet_hours: QuietHoursConfig | undefined;
  if (raw.quiet_hours !== undefined) {
    const qWhere = `${where}.quiet_hours`;
    if (!isRecord(raw.quiet_hours)) fail('{where} must be a mapping.', { where: qWhere });
    const qUnknown = Object.keys(raw.quiet_hours).filter(k => !['from', 'to', 'except'].includes(k));
    if (qUnknown.length) fail('{where}: unknown key(s): {keys}.', { where: qWhere, keys: qUnknown.join(', ') });
    const from = validateTimeHm(raw.quiet_hours.from, 'from', qWhere);
    const qTo = validateTimeHm(raw.quiet_hours.to, 'to', qWhere);
    const except: TriggerName[] = [];
    if (raw.quiet_hours.except !== undefined) {
      if (!Array.isArray(raw.quiet_hours.except) || raw.quiet_hours.except.some(e => typeof e !== 'string')) {
        fail('{where}: "except" must be a list of trigger names.', { where: qWhere });
      }
      for (const item of raw.quiet_hours.except as string[]) {
        if (!(TRIGGER_NAMES as readonly string[]).includes(item)) {
          fail('{where}: unknown trigger "{name}" (known: {known}).', { where: `${qWhere}.except`, name: item, known: TRIGGER_NAMES.join(', ') });
        }
        const trig = item as TriggerName;
        if (!except.includes(trig)) except.push(trig);
      }
    }
    quiet_hours = { from, to: qTo, except };
  }

  let digest: DigestConfig | undefined;
  if (raw.digest !== undefined) {
    const dWhere = `${where}.digest`;
    if (!isRecord(raw.digest)) fail('{where} must be a mapping.', { where: dWhere });
    const dUnknown = Object.keys(raw.digest).filter(k => !['at', 'to'].includes(k));
    if (dUnknown.length) fail('{where}: unknown key(s): {keys}.', { where: dWhere, keys: dUnknown.join(', ') });
    const at = validateTimeHm(raw.digest.at, 'at', dWhere);
    const dTo = raw.digest.to === undefined ? [...to] : validateChannelRefs(raw.digest.to, channels, `${dWhere}.to`);
    if (!dTo.length) fail('{where}: "to" must name at least one channel.', { where: dWhere });
    digest = { at, to: dTo };
  }

  const rawTriggers = raw.triggers === undefined ? {} : raw.triggers;
  if (!isRecord(rawTriggers)) fail('{where} must be a mapping.', { where: `${where}.triggers` });
  for (const key of Object.keys(rawTriggers)) {
    if (!(TRIGGER_NAMES as readonly string[]).includes(key)) {
      fail('{where}: unknown trigger "{name}" (known: {known}).', { where: `${where}.triggers`, name: key, known: TRIGGER_NAMES.join(', ') });
    }
  }
  const triggers = {} as Record<TriggerName, TriggerConfig>;
  for (const name of TRIGGER_NAMES) {
    triggers[name] = rawTriggers[name] === undefined
      ? { after_minutes: DEFAULT_TRIGGER_MINUTES[name], off: false }
      : validateTrigger(name, rawTriggers[name], channels, `${where}.triggers.${name}`);
  }

  return {
    channels,
    to,
    ...(quiet_hours ? { quiet_hours } : {}),
    ...(digest ? { digest } : {}),
    triggers,
  };
}

export function effectiveChannelsFor(config: NotifyConfig, trigger: TriggerName): string[] {
  return config.triggers[trigger].to ?? config.to;
}

export function parseClockMinutes(hm: string): number {
  const m = CLOCK_HM.exec(hm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isInQuietHours(now: Date, quiet: QuietHoursConfig | undefined): boolean {
  if (!quiet) return false;
  const from = parseClockMinutes(quiet.from);
  const to = parseClockMinutes(quiet.to);
  if (from === to) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}
