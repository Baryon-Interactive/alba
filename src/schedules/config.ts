import path from 'node:path';
import { fail } from '../i18n.ts';
import { parseCron } from './cron.ts';

export type ScheduleCatchUp = 'latest' | 'none';

export interface ScheduleConfig {
  id: string;
  /** Resolved path to the Markdown order template file. */
  order: string;
  /** Tag pattern with {date} (YYYYMMDD) and optional {time} (HHMM). */
  tag: string;
  every_minutes?: number;
  daily_at?: string;
  cron?: string;
  precheck?: string | string[];
  catch_up: ScheduleCatchUp;
  max_open: number;
  enabled: boolean;
  /** Optional order fields applied when the order is created. */
  title?: string;
  kind?: string;
  worker?: string;
  priority?: number;
  needs?: string[];
}

const KNOWN_KEYS = [
  'id', 'order', 'tag', 'every_minutes', 'daily_at', 'cron',
  'precheck', 'catch_up', 'max_open', 'enabled', 'title', 'kind', 'worker', 'priority', 'needs',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the `schedules:` list of a project configuration file. */
export function validateSchedules(raw: unknown, file: string, base: string): ScheduleConfig[] {
  if (!Array.isArray(raw)) fail('{file}: "schedules" must be a list.', { file });
  const seen = new Set<string>();
  const out: ScheduleConfig[] = [];

  for (const [i, item] of raw.entries()) {
    const at = `schedules[${i}]`;
    if (!isRecord(item)) fail('{file}: "{at}" must be a mapping.', { file, at });
    const unknown = Object.keys(item).filter(k => !(KNOWN_KEYS as readonly string[]).includes(k));
    if (unknown.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: unknown.join(', ') });

    const id = item.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
      fail('{file}: "{at}.id" must be a non-empty string using only a-z, 0-9 and "-".', { file, at });
    }
    if (seen.has(id)) fail('{file}: duplicate schedule id "{id}".', { file, id });
    seen.add(id);

    const order = item.order;
    if (typeof order !== 'string' || !order.trim()) {
      fail('{file}: "{at}.order" must be a path to a Markdown order template.', { file, at });
    }

    const tag = item.tag;
    if (typeof tag !== 'string' || !tag.trim()) {
      fail('{file}: "{at}.tag" must be a non-empty tag pattern.', { file, at });
    }
    const trimmedTag = tag.trim();
    const placeholders = [...trimmedTag.matchAll(/\{([^}]*)\}/g)].map(m => m[1]);
    const badPlaceholders = placeholders.filter(p => p !== 'date' && p !== 'time');
    if (badPlaceholders.length) {
      fail('{file}: "{at}.tag" has unsupported placeholder(s): {list}. Use {{date}} and optional {{time}}.', { file, at, list: badPlaceholders.join(', ') });
    }
    if (!placeholders.includes('date')) {
      fail('{file}: "{at}.tag" must include the {{date}} placeholder.', { file, at });
    }
    const sampleTag = trimmedTag.replaceAll('{date}', '20260101').replaceAll('{time}', '0000');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sampleTag)) {
      fail('{file}: "{at}.tag" expands to an invalid order tag "{sample}".', { file, at, sample: sampleTag });
    }

    const modes = (['every_minutes', 'daily_at', 'cron'] as const).filter(k => item[k] !== undefined);
    if (modes.length !== 1) {
      fail('{file}: "{at}" must set exactly one of every_minutes, daily_at or cron.', { file, at });
    }

    let every_minutes: number | undefined;
    let daily_at: string | undefined;
    let cron: string | undefined;

    if (item.every_minutes !== undefined) {
      if (typeof item.every_minutes !== 'number' || !Number.isInteger(item.every_minutes) || item.every_minutes < 15) {
        fail('{file}: "{at}.every_minutes" must be a whole number >= 15.', { file, at });
      }
      every_minutes = item.every_minutes;
    }
    if (item.daily_at !== undefined) {
      if (typeof item.daily_at !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.daily_at.trim())) {
        fail('{file}: "{at}.daily_at" must be HH:MM (24-hour local time).', { file, at });
      }
      daily_at = item.daily_at.trim();
    }
    if (item.cron !== undefined) {
      if (typeof item.cron !== 'string' || !item.cron.trim()) {
        fail('{file}: "{at}.cron" must be a 5-field cron expression.', { file, at });
      }
      cron = item.cron.trim();
      parseCron(cron);
    }

    const catch_up = item.catch_up === undefined ? 'latest' : item.catch_up;
    if (catch_up !== 'latest' && catch_up !== 'none') {
      fail('{file}: "{at}.catch_up" must be "latest" or "none".', { file, at });
    }

    const max_open = item.max_open === undefined ? 1 : item.max_open;
    if (typeof max_open !== 'number' || !Number.isInteger(max_open) || max_open < 1) {
      fail('{file}: "{at}.max_open" must be a whole number >= 1.', { file, at });
    }

    const enabled = item.enabled === undefined ? true : item.enabled;
    if (typeof enabled !== 'boolean') {
      fail('{file}: "{at}.enabled" must be true or false.', { file, at });
    }

    const entry: ScheduleConfig = {
      id,
      order: path.resolve(base, order.trim()),
      tag: trimmedTag,
      ...(every_minutes !== undefined ? { every_minutes } : {}),
      ...(daily_at !== undefined ? { daily_at } : {}),
      ...(cron !== undefined ? { cron } : {}),
      catch_up,
      max_open,
      enabled,
    };

    if (item.precheck !== undefined) {
      const command = item.precheck;
      if (typeof command === 'string' && command.trim()) entry.precheck = command.trim();
      else if (Array.isArray(command) && command.length && command.every(arg => typeof arg === 'string') && command[0].trim()) entry.precheck = [...command];
      else fail('{file}: "{at}.precheck" must be a command or a program and arguments.', { file, at });
    }
    if (item.title !== undefined) {
      if (typeof item.title !== 'string' || !item.title.trim()) fail('{file}: "{at}.title" must be non-empty text.', { file, at });
      entry.title = item.title.trim();
    }
    if (item.kind !== undefined) {
      if (typeof item.kind !== 'string' || !item.kind.trim()) fail('{file}: "{at}.kind" must be non-empty text.', { file, at });
      entry.kind = item.kind.trim();
    }
    if (item.worker !== undefined) {
      if (typeof item.worker !== 'string' || !item.worker.trim()) fail('{file}: "{at}.worker" must be a worker id.', { file, at });
      entry.worker = item.worker.trim();
    }
    if (item.priority !== undefined) {
      if (typeof item.priority !== 'number' || !Number.isInteger(item.priority) || Math.abs(item.priority) > 1_000_000) {
        fail('{file}: "{at}.priority" must be a bounded integer.', { file, at });
      }
      entry.priority = item.priority;
    }
    if (item.needs !== undefined) {
      if (!Array.isArray(item.needs) || item.needs.some(n => typeof n !== 'string' || !n.trim())) {
        fail('{file}: "{at}.needs" must be a list of order tags.', { file, at });
      }
      entry.needs = (item.needs as string[]).map(n => n.trim());
    }

    out.push(entry);
  }
  return out;
}
