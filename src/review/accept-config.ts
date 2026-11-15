import path from 'node:path';

export interface AcceptStep {
  name: string;
  command: string[];
  timeout_minutes: number;
  when_changed?: string[];
  resource?: string;
  artifacts?: string[];
  artifacts_required?: boolean;
}
export interface AcceptConfig {
  independent_check?: boolean | Record<string, boolean>;
  git_timeout_minutes?: number;
  conflicts: { take_base: string[]; take_branch: string[]; drop: string[] };
  steps: AcceptStep[];
  note_template?: string;
  merge_message: string;
  post_merge: string[][];
  push: boolean;
  parallel: number;
}

export function validateAccept(raw: unknown, base: string): AcceptConfig {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const bad = (key: string): never => { throw new Error(`Invalid accept.${key} configuration.`); };
  const keys = (v: Record<string, unknown>, allowed: string[], key: string) => { if (Object.keys(v).some(k => !allowed.includes(k))) bad(key); };
  const strings = (v: unknown, key: string): string[] => {
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s.trim())) return bad(key);
    return v as string[];
  };
  const command = (v: unknown, key: string): string[] => { const out = strings(v, key); return out.length ? out : bad(key); };
  if (!record(raw)) return bad('mapping');
  keys(raw, ['independent_check', 'git_timeout_minutes', 'conflicts', 'steps', 'note_template', 'merge_message', 'post_merge', 'push', 'parallel'], 'keys');
  if (raw.git_timeout_minutes !== undefined && (typeof raw.git_timeout_minutes !== 'number' || !Number.isFinite(raw.git_timeout_minutes) || raw.git_timeout_minutes <= 0)) bad('git_timeout_minutes');
  if (raw.independent_check !== undefined && typeof raw.independent_check !== 'boolean'
    && (!record(raw.independent_check) || Object.values(raw.independent_check).some(v => typeof v !== 'boolean'))) bad('independent_check');
  const conflicts: AcceptConfig['conflicts'] = { take_base: [], take_branch: [], drop: [] };
  if (raw.conflicts !== undefined) {
    if (!record(raw.conflicts)) return bad('conflicts');
    keys(raw.conflicts, Object.keys(conflicts), 'conflicts');
    for (const key of Object.keys(conflicts) as (keyof typeof conflicts)[]) if (raw.conflicts[key] !== undefined) conflicts[key] = strings(raw.conflicts[key], `conflicts.${key}`);
  }
  if (raw.steps !== undefined && !Array.isArray(raw.steps)) return bad('steps');
  const steps = ((raw.steps ?? []) as unknown[]).map((step, index): AcceptStep => {
    if (!record(step)) return bad(`steps[${index}]`);
    keys(step, ['name', 'command', 'timeout_minutes', 'when_changed', 'resource', 'artifacts', 'artifacts_required'], 'steps');
    if (typeof step.name !== 'string' || !step.name.trim() || typeof step.timeout_minutes !== 'number' || !Number.isFinite(step.timeout_minutes) || step.timeout_minutes <= 0) return bad('steps');
    if (step.resource !== undefined && (typeof step.resource !== 'string' || !step.resource.trim())) return bad('steps.resource');
    if (step.artifacts !== undefined && (!Array.isArray(step.artifacts) || (step.artifacts as unknown[]).some(a => typeof a !== 'string' || !a.trim()))) return bad('steps.artifacts');
    if (step.artifacts_required !== undefined && typeof step.artifacts_required !== 'boolean') return bad('steps.artifacts_required');
    return { name: step.name, command: command(step.command, 'steps.command'), timeout_minutes: step.timeout_minutes, ...(step.when_changed !== undefined ? { when_changed: strings(step.when_changed, 'steps.when_changed') } : {}), ...(step.resource ? { resource: step.resource as string } : {}), ...(step.artifacts !== undefined ? { artifacts: step.artifacts as string[] } : {}), ...(step.artifacts_required === true ? { artifacts_required: true } : {}) };
  });
  if (new Set(steps.map(s => s.name)).size !== steps.length) return bad('steps.name');
  for (const key of ['note_template', 'merge_message'] as const) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) return bad(key);
  if (raw.push !== undefined && typeof raw.push !== 'boolean') return bad('push');
  if (raw.parallel !== undefined && (typeof raw.parallel !== 'number' || !Number.isInteger(raw.parallel) || raw.parallel < 1)) return bad('parallel');
  if (raw.post_merge !== undefined && !Array.isArray(raw.post_merge)) return bad('post_merge');
  return { ...(raw.independent_check !== undefined ? { independent_check: raw.independent_check as AcceptConfig['independent_check'] } : {}), git_timeout_minutes: raw.git_timeout_minutes as number ?? 2, conflicts, steps, merge_message: raw.merge_message as string ?? 'Merge {tag}: {title}', ...(raw.note_template ? { note_template: path.resolve(base, raw.note_template as string) } : {}), post_merge: ((raw.post_merge ?? []) as unknown[]).map(c => command(c, 'post_merge')), push: raw.push === true, parallel: raw.parallel as number ?? 1 };
}
