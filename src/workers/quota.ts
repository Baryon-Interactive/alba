import type { CommandQuota, DisabledRule, QuotaConfig, StaticQuota, WorkerConfig } from './config.ts';
import { t } from '../i18n.ts';
import { local } from '../time.ts';

export interface QuotaWindow { name: string; usedPercent: number; resetsAt?: string }
export interface QuotaReading {
  source: string;
  at: string;
  ok: boolean;
  error?: string;
  note?: string;
  windows: QuotaWindow[];
  balance?: { raw: string; amount?: number };
  entries: number;          // how many items of the command output were merged into this reading
}

/** Reads a value by a path like `a.b[0].c`. */
export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.').filter(Boolean)) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) current = (current as Record<string, unknown> | undefined)?.[m[1]];
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) current = (current as unknown[] | undefined)?.[Number(idx[1])];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

const amountOf = (raw: string): number | undefined => {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(raw);
  return m ? Number(m[0].replace(/,/g, '')) : undefined;
};

/**
 * Turns the JSON a quota command printed into one reading. Items selected for this source are treated as
 * interchangeable accounts: a window counts as used up only if it is used up everywhere it exists.
 */
export function parseCommandQuota(source: string, config: CommandQuota, output: string, at: string): QuotaReading {
  let data: unknown;
  try { data = JSON.parse(output); } catch (e) { return failed(source, at, t('the command did not print JSON: {error}', { error: (e as Error).message })); }
  let items = Array.isArray(data) ? data : [data];
  if (config.select) items = items.filter(i => String(getPath(i, config.select!.field)) === config.select!.equals);
  if (!items.length) return failed(source, at, t('no item in the output matches {field} = {value}', { field: config.select?.field ?? '', value: config.select?.equals ?? '' }));
  const byName = new Map<string, QuotaWindow>();
  let sum = 0, any = false;
  const balances: string[] = [];
  for (const item of items) {
    const windows = getPath(item, config.windows);
    for (const w of Array.isArray(windows) ? windows : []) {
      const name = getPath(w, config.window_fields.name), used = getPath(w, config.window_fields.used), resets = getPath(w, config.window_fields.resets_at);
      if (typeof name !== 'string' || typeof used !== 'number') continue;
      const entry: QuotaWindow = { name, usedPercent: used, ...(typeof resets === 'string' ? { resetsAt: resets } : {}) };
      const have = byName.get(name);
      const better = !have || entry.usedPercent < have.usedPercent
        || (entry.usedPercent === have.usedPercent && entry.resetsAt !== undefined && (have.resetsAt === undefined || Date.parse(entry.resetsAt) < Date.parse(have.resetsAt)));
      if (better) byName.set(name, entry);
    }
    const balance = config.balance ? getPath(item, config.balance) : undefined;
    if (typeof balance === 'string') { balances.push(balance); const n = amountOf(balance); if (n !== undefined) { sum += n; any = true; } }
  }
  const reading: QuotaReading = { source, at, ok: true, windows: [...byName.values()], entries: items.length };
  if (balances.length) reading.balance = { raw: balances.length === 1 ? balances[0] : balances.join(' + '), ...(any ? { amount: sum } : {}) };
  return reading;
}

export function staticQuota(source: string, config: StaticQuota, at: string): QuotaReading {
  const reading: QuotaReading = { source, at, ok: true, entries: 1, windows: config.windows.map(w => ({ name: w.name, usedPercent: w.used_percent, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) })) };
  if (config.balance) reading.balance = { raw: config.balance, amount: amountOf(config.balance) };
  return reading;
}

export function failed(source: string, at: string, error: string): QuotaReading {
  return { source, at, ok: false, error, windows: [], entries: 0 };
}

/** The balance change since the most recent earlier reading of the same source: positive means it fell. */
export function balanceDrop(history: readonly QuotaReading[], current: QuotaReading): { drop: number; since: string } | undefined {
  if (current.balance?.amount === undefined) return undefined;
  const earlier = history.filter(h => h.source === current.source && h.ok && h.balance?.amount !== undefined && h.at < current.at);
  const previous = earlier[earlier.length - 1];
  if (!previous) return undefined;
  return { drop: previous.balance!.amount! - current.balance.amount, since: previous.at };
}

export interface WorkerAvailability {
  available: boolean;
  reasons: string[];        // why it is not available (empty when it is)
  alerts: string[];         // things a person should hear about, even if the worker is available
}

const matches = (pattern: string, name: string) =>
  pattern === '*' || new RegExp(`^${pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);

/** Variables that sign a Claude worker in. Alba gives each Claude worker a config folder of its own and removes inherited `ANTHROPIC_*` / `CLAUDE_CODE_*`, so the person's `claude` login is not seen. */
const CLAUDE_SIGN_IN = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
/** A warning when a claude-cli worker's launch.env names no way to sign in. */
export function claudeCredentialsMissing(worker: WorkerConfig): string | undefined {
  if (worker.engine !== 'claude-cli' || !worker.launch) return undefined;
  if (CLAUDE_SIGN_IN.some(name => name in worker.launch!.env)) return undefined;
  return t('{worker}: launch.env names no Claude sign-in, and a Claude worker does not see your own claude login (it gets a config folder of its own). For a subscription run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}"; for the API add ANTHROPIC_API_KEY.', { worker: worker.id });
}

/** Applies a worker's enabled flag and disabled_when rules to its latest quota reading. */
export function availability(worker: WorkerConfig, reading: QuotaReading | undefined, history: readonly QuotaReading[], now: Date): WorkerAvailability {
  const out: WorkerAvailability = { available: true, reasons: [], alerts: [] };
  if (!worker.enabled) { out.available = false; out.reasons.push(t('turned off in the workers file')); return out; }
  if (!worker.launch && !worker.card_only) { out.available = false; out.reasons.push(t('it has no launch template, so alba cannot start it')); return out; }
  const credentials = claudeCredentialsMissing(worker);
  if (credentials) out.alerts.push(credentials);
  if (worker.quota && (!reading || !reading.ok)) {
    out.available = false;
    out.reasons.push(t('quota unreadable'));
    out.alerts.push(t('{worker}: quota could not be read ({error}); it is not used until it can be.', { worker: worker.id, error: reading?.error ?? 'no reading' }));
    return out;
  }
  for (const rule of worker.disabled_when as DisabledRule[]) {
    if ('window_full' in rule) {
      for (const w of reading!.windows.filter(x => matches(rule.window_full, x.name))) {
        const resets = w.resetsAt ? Date.parse(w.resetsAt) : undefined;
        if (w.usedPercent >= rule.at && (resets === undefined || resets > now.getTime())) {
          out.available = false;
          out.reasons.push(t('window "{name}" is {used}% used{resets}', { name: w.name, used: Math.round(w.usedPercent), resets: w.resetsAt ? t(', resets {when}', { when: local(w.resetsAt) }) : '' }));
        }
      }
    } else {
      const change = balanceDrop(history, reading!);
      if (change && change.drop > rule.balance_drop) {
        out.available = false;
        const text = t('balance fell by {drop} since {since} (limit {limit})', { drop: Number(change.drop.toFixed(2)), since: local(change.since), limit: rule.balance_drop });
        out.reasons.push(text);
        out.alerts.push(`${worker.id}: ${text}`);
      }
    }
  }
  return out;
}

export type { QuotaConfig };
