import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RunUsage } from '../api/types.ts';
import { fail } from '../i18n.ts';

export interface ConsultConfig {
  enabled: boolean;
  role: string;
  max_per_run: number;
  timeout_minutes: number;
  kinds?: string[];
}

export type ConsultOutcome = 'ok' | 'refused' | 'timeout' | 'failed';

export interface ConsultRecord {
  at: string;
  question: string;
  files?: string[];
  consultant: string;
  engine?: string;
  model: string;
  model_family?: string;
  seconds: number;
  outcome: ConsultOutcome;
  answer_length: number;
  answer?: string;
  reason?: string;
  worktree_changed?: boolean;
  usage?: RunUsage;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateConsult(raw: unknown, file: string): ConsultConfig {
  if (!isRecord(raw)) fail('{file}: "consult" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['enabled', 'role', 'max_per_run', 'timeout_minutes', 'kinds'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "consult": {keys}.', { file, keys: unknown.join(', ') });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    fail('{file}: "consult.enabled" must be true or false.', { file });
  }
  let role = 'consultant';
  if (raw.role !== undefined) {
    if (typeof raw.role !== 'string' || !IDENTIFIER_RE.test(raw.role.trim())) {
      fail('{file}: "consult.role" must be a role name.', { file });
    }
    role = raw.role.trim();
  }
  let maxPerRun = 3;
  if (raw.max_per_run !== undefined) {
    if (typeof raw.max_per_run !== 'number' || !Number.isInteger(raw.max_per_run) || raw.max_per_run < 1) {
      fail('{file}: "consult.max_per_run" must be a whole number >= 1.', { file });
    }
    maxPerRun = raw.max_per_run;
  }
  let timeoutMinutes = 10;
  if (raw.timeout_minutes !== undefined) {
    if (typeof raw.timeout_minutes !== 'number' || !Number.isFinite(raw.timeout_minutes) || raw.timeout_minutes <= 0 || raw.timeout_minutes > 30) {
      fail('{file}: "consult.timeout_minutes" must be a positive number <= 30.', { file });
    }
    timeoutMinutes = raw.timeout_minutes;
  }
  let kinds: string[] | undefined;
  if (raw.kinds !== undefined) {
    if (!Array.isArray(raw.kinds) || !raw.kinds.length || raw.kinds.some(x => typeof x !== 'string' || !IDENTIFIER_RE.test(x.trim()))) {
      fail('{file}: "consult.kinds" must be a non-empty list of kinds.', { file });
    }
    kinds = [...new Set((raw.kinds as string[]).map(x => x.trim()))];
  }
  return {
    enabled: raw.enabled === true,
    role,
    max_per_run: maxPerRun,
    timeout_minutes: timeoutMinutes,
    ...(kinds ? { kinds } : {}),
  };
}

export const consultsFileOf = (stateDir: string, tag: string, runId: string): string =>
  path.join(stateDir, 'runs', `${tag}-${runId}.consults.jsonl`);

export function parseConsultRecords(text: string): ConsultRecord[] {
  const out: ConsultRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (typeof v.at !== 'string' || typeof v.question !== 'string' || typeof v.outcome !== 'string') continue;
      out.push(v as unknown as ConsultRecord);
    } catch { /* ignore partial or malformed lines */ }
  }
  return out;
}

export function readRunConsults(stateDir: string | undefined, tag: string, runId: string): ConsultRecord[] {
  if (!stateDir) return [];
  const file = consultsFileOf(stateDir, tag, runId);
  if (!existsSync(file)) return [];
  try { return parseConsultRecords(readFileSync(file, 'utf8')); } catch { return []; }
}

export function consultsToday(stateDir: string | undefined, day: string): number {
  if (!stateDir) return 0;
  const runsDir = path.join(stateDir, 'runs');
  if (!existsSync(runsDir)) return 0;
  let count = 0;
  try {
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.consults.jsonl')) continue;
      const full = path.join(runsDir, name);
      try {
        if (statSync(full).mtime.toISOString().slice(0, 10) < day) continue;
        for (const r of parseConsultRecords(readFileSync(full, 'utf8'))) {
          if (r.outcome !== 'refused' && r.at.slice(0, 10) === day) count++;
        }
      } catch { /* skip unreadable file */ }
    }
  } catch { /* runs dir missing */ }
  return count;
}
