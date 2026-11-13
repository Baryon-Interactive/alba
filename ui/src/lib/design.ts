import type { ChangeSet, DesignKind, Entity, History, Library, MeasurementView, Param, System, Target } from '../../../src/design/model.ts';
export type { ChangeSet, DesignKind, Entity, Formula, Gap, History, Library, Milestone, Param, Rule, System, Target, Term } from '../../../src/design/model.ts';
export type LiveParam = Param & { value?: unknown; error?: string };
export type DesignBundle = Library & { resolved_values: { id: string; value?: unknown; error?: string }[]; history: History[]; measurements?: MeasurementView[] };
export type StaleSystem = { system: string; orders: string[]; unknown_orders: string[] };
export type DesignResult = { applied: boolean; dryRun: boolean; warnings: { entity: string; message: string }[]; export_error?: string };
export const kinds: DesignKind[] = ['system', 'rule', 'formula', 'param', 'target', 'gap', 'milestone', 'term', 'decision_link'];
export const idOf = (kind: DesignKind, row: Entity): string => kind === 'system' ? (row as System).code : kind === 'term' ? (row as { term: string }).term : kind === 'decision_link' ? `${(row as Library['decision_link'][number]).decision}:${(row as Library['decision_link'][number]).kind}:${(row as Library['decision_link'][number]).entity}` : (row as { id: string }).id;
export const outside = (value: unknown, min: number | null, max: number | null) => typeof value === 'number' && ((min !== null && value < min) || (max !== null && value > max));
export const targetState = (row?: Target) => !row || row.last_value === null ? 'unmeasured' : outside(row.last_value, row.min, row.max) ? 'failing' : 'passing';
export const liveParams = (data: DesignBundle, system?: string): LiveParam[] => data.param.filter(p => !system || p.system === system).map(p => ({ ...p, ...data.resolved_values.find(v => v.id === p.id) }));
export function systemStats(data: Library, code: string) {
  const rules = data.rule.filter(r => r.system === code && r.status === 'active');
  const targets = data.target.filter(r => r.system === code);
  const gaps = data.gap.filter(r => r.system === code && r.status === 'open');
  return { rules: { done: rules.filter(r => r.implementation === 'done').length, partial: rules.filter(r => r.implementation === 'partial').length, none: rules.filter(r => r.implementation === 'none').length }, formulas: data.formula.filter(r => r.system === code).length, params: data.param.filter(r => r.system === code).length, passing: targets.filter(r => targetState(r) === 'passing').length, failing: targets.filter(r => targetState(r) === 'failing').length, unmeasured: targets.filter(r => targetState(r) === 'unmeasured').length, assigned: gaps.filter(r => !!r.order).length, unassigned: gaps.filter(r => !r.order).length };
}
export function searchEntities(data: Library, query: string) {
  if (!query.trim()) return [];
  const needle = query.trim().toLowerCase();
  return kinds.flatMap(kind => data[kind].filter(row => JSON.stringify(row).toLowerCase().includes(needle)).map(row => ({ kind, row })));
}
export function systemHistory(data: DesignBundle, code: string) {
  const ids = new Set(kinds.flatMap(kind => data[kind].filter(row => kind === 'system' ? (row as System).code === code : 'system' in row && row.system === code).map(row => `${kind}:${idOf(kind, row)}`)));
  data.decision_link.filter(link => ids.has(`${link.kind}:${link.entity}`)).forEach(link => ids.add(`decision_link:${idOf('decision_link', link)}`));
  return data.history.filter(h => ids.has(`${h.kind}:${h.entity}`)).sort((a, b) => b.id - a.id);
}
const csvCell = (value: unknown) => {
  let text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function paramsCsv(rows: LiveParam[]) {
  const columns = ['id', 'meaning', 'value', 'unit', 'type', 'range_min', 'range_max', 'source', 'source_ref', 'file', 'pointer', 'rules', 'formulas', 'error'];
  return '\uFEFF' + [columns, ...rows.map(p => columns.map(k => k === 'file' ? p.location.file : k === 'pointer' ? p.location.pointer : (p as unknown as Record<string, unknown>)[k]))].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export interface Field { key: string; label: string; type?: 'number' | 'json' | 'list' | 'long'; nullable?: boolean; optional?: boolean; choices?: string[] }
const f = (key: string, label: string, rest: Partial<Field> = {}): Field => ({ key, label, ...rest });
const list = (key: string, label: string) => f(key, label, { type: 'list' });
const num = (key: string, label: string) => f(key, label, { type: 'number', nullable: true });
export const schema: Record<DesignKind, Field[]> = {
  system: [f('code', 'Code'), f('name', 'Name'), f('summary', 'Summary', { type: 'long' }), f('status', 'Status', { choices: ['not-started', 'prototype', 'playable', 'done'] }), list('source_refs', 'Document sources'), list('code_globs', 'Code patterns'), list('data_globs', 'Data patterns'), f('verified_commit', 'Verified commit', { nullable: true }), f('verified_at', 'Verified date', { nullable: true })],
  rule: [f('id', 'Id'), f('system', 'System'), f('text', 'Text', { type: 'long' }), f('sources', 'Sources', { type: 'json' }), f('status', 'Status', { choices: ['active', 'retired'] }), f('superseded_by', 'Superseded by', { nullable: true }), f('implementation', 'Implementation', { choices: ['none', 'partial', 'done'] }), f('evidence', 'Evidence', { type: 'json' })],
  formula: [f('id', 'Id'), f('system', 'System'), f('expression', 'Expression', { type: 'long' }), list('variables', 'Variables'), f('number_kind', 'Number kind', { choices: ['integer', 'fixed', 'float'] }), f('rounding', 'Rounding'), f('timing', 'Timing'), list('code_refs', 'Code references'), f('notes', 'Notes', { type: 'long', optional: true })],
  param: [f('id', 'Id'), f('system', 'System'), f('location', 'Location', { type: 'json' }), f('meaning', 'Meaning', { type: 'long' }), f('unit', 'Unit'), f('type', 'Type', { choices: ['int', 'permille', 'milli', 'float', 'bool', 'string'] }), num('range_min', 'Minimum'), num('range_max', 'Maximum'), f('source', 'Source', { choices: ['baseline', 'decision', 'tuned'] }), f('source_ref', 'Source reference'), list('rules', 'Rules'), list('formulas', 'Formulas')],
  target: [f('id', 'Id'), f('system', 'System'), f('metric', 'Metric'), num('min', 'Minimum'), num('max', 'Maximum'), f('unit', 'Unit'), f('command', 'Measurement command', { type: 'long' }), f('measure', 'Structured measurement', { type: 'json', nullable: true, optional: true }), num('last_value', 'Last value'), f('measured_commit', 'Measured commit', { nullable: true }), f('measured_at', 'Measured date', { nullable: true }), f('evidence', 'Evidence', { type: 'json' })],
  gap: [f('id', 'Id'), f('system', 'System'), f('text', 'Text', { type: 'long' }), list('refs', 'References'), f('order', 'Order', { nullable: true }), f('status', 'Status', { choices: ['open', 'closed'] }), f('closed_by', 'Closed by', { nullable: true })],
  milestone: [f('id', 'Id'), f('name', 'Name'), f('position', 'Position', { type: 'number' }), f('status', 'Status', { choices: ['not-started', 'active', 'done'] }), { ...list('systems', 'Systems'), optional: true }, f('criteria', 'Criteria', { type: 'json' })],
  term: [f('term', 'Term'), f('meaning', 'Meaning', { type: 'long' }), list('avoid', 'Avoid'), f('system', 'System', { nullable: true })],
  decision_link: [f('decision', 'Decision id'), f('kind', 'Entity kind', { choices: kinds.filter(k => k !== 'decision_link') }), f('entity', 'Entity id')],
};
export function formOf(kind: DesignKind, row?: Entity, system = ''): Record<string, string> {
  const values = (row ?? {}) as unknown as Record<string, unknown>;
  return Object.fromEntries(schema[kind].map(field => {
    const value = values[field.key] ?? (field.key === 'system' ? system : field.type === 'list' ? [] : field.type === 'json' ? field.key === 'measure' ? null : field.key === 'location' ? { file: '', pointer: '' } : [] : field.choices?.[0] ?? '');
    return [field.key, field.type === 'list' ? (value as string[]).join('\n') : field.type === 'json' ? JSON.stringify(value, null, 2) : String(value)];
  }));
}
export function buildChange(kind: DesignKind, form: Record<string, string>, row?: Entity, retire = false, decision = ''): { changeset?: ChangeSet; problems: Record<string, string> } {
  const problems: Record<string, string> = {}, fields: Record<string, unknown> = {};
  for (const field of schema[kind]) {
    const value = (form[field.key] ?? '').trim();
    if (field.nullable && !value) { fields[field.key] = null; continue; }
    if (field.type === 'list') fields[field.key] = value.split('\n').map(s => s.trim()).filter(Boolean);
    else if (field.type === 'json') {
      try {
        const parsed: unknown = JSON.parse(value);
        const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
        const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
        if (field.key === 'measure') {
          if (parsed !== null && (!object(parsed) || !Array.isArray(parsed.argv) || !parsed.argv.length || !parsed.argv.every(v => typeof v === 'string') || !object(parsed.value) || !object(parsed.when) || typeof parsed.timeout_minutes !== 'number' || !Number.isFinite(parsed.timeout_minutes) || parsed.timeout_minutes <= 0)) throw new Error();
        } else if (field.key === 'location') {
          if (!object(parsed) || !text(parsed.file) || typeof parsed.pointer !== 'string' || parsed.pointer !== '' && (!parsed.pointer.startsWith('/') || /~(?:[^01]|$)/.test(parsed.pointer)) || Object.keys(parsed).some(k => !['file', 'pointer'].includes(k))) throw new Error();
        } else {
          if (!Array.isArray(parsed)) throw new Error();
          if (field.key === 'sources' || field.key === 'evidence') {
            const choices = field.key === 'sources' ? ['decision', 'doc'] : ['order', 'file', 'report'];
            if (!parsed.every(v => object(v) && choices.includes(String(v.kind)) && text(v.ref) && Object.keys(v).every(k => ['kind', 'ref'].includes(k)))) throw new Error();
          }
          if (field.key === 'criteria' && !parsed.every(v => object(v) && Object.keys(v).length === 1 && (text(v.target) || text(v.text)))) throw new Error();
        }
        fields[field.key] = parsed;
      } catch { problems[field.key] = 'Enter valid JSON of the required shape.'; }
    } else if (field.type === 'number') {
      if (!value || !Number.isFinite(Number(value)) || (field.key === 'position' && !Number.isSafeInteger(Number(value)))) problems[field.key] = 'Enter a finite number (a whole number for position).';
      else fields[field.key] = Number(value);
    } else if (!value && !field.optional) problems[field.key] = 'This field is required.';
    else fields[field.key] = value;
    if (field.choices && !field.choices.includes(value)) problems[field.key] = 'Choose a listed value.';
  }
  const identity = kind === 'system' ? 'code' : kind === 'term' ? 'term' : 'id';
  const id = row ? idOf(kind, row) : kind === 'decision_link' ? `${fields.decision}:${fields.kind}:${fields.entity}` : String(fields[identity] ?? '');
  const pattern = kind === 'system' ? /^[A-Z][A-Z0-9]{1,11}$/ : kind === 'param' ? /^[A-Z][A-Z0-9]{1,11}\.[a-z_]+\.[a-z_]+$/ : kind === 'milestone' ? /^M-[A-Z0-9_-]+$/ : ['rule', 'formula', 'target', 'gap'].includes(kind) ? new RegExp(`^[A-Z][A-Z0-9]{1,11}-${({ rule: 'R', formula: 'F', target: 'T', gap: 'G' } as Record<string, string>)[kind]}\\d{2,}$`) : null;
  if (pattern && !pattern.test(id)) problems[identity] = 'Use the documented entity id format.';
  for (const [low, high] of [['range_min', 'range_max'], ['min', 'max']]) if (typeof fields[low] === 'number' && typeof fields[high] === 'number' && fields[low] > fields[high]) problems[high] = 'Maximum must be at least minimum.';
  for (const key of ['verified_at', 'measured_at']) if (fields[key] && !Number.isFinite(Date.parse(String(fields[key])))) problems[key] = 'Enter an ISO date and time.';
  if (kind === 'system' && (fields.verified_at === null) !== (fields.verified_commit === null)) problems.verified_at = 'Provide both commit and date.';
  if (kind === 'target' && fields.min === null && fields.max === null) problems.min = 'Provide at least one bound.';
  if (kind === 'target' && fields.last_value !== null && (!fields.measured_commit || !fields.measured_at || !(fields.evidence as unknown[] | undefined)?.length)) problems.last_value = 'Measurements need commit, date and evidence.';
  if (kind === 'rule' && (retire || fields.status === 'retired') && !fields.superseded_by) problems.superseded_by = 'Name the replacement rule or decision.';
  if (kind === 'rule' && !(fields.sources as unknown[] | undefined)?.length) problems.sources = 'A rule needs a source.';
  if (kind === 'rule' && fields.implementation !== 'none' && !(fields.evidence as unknown[] | undefined)?.length) problems.evidence = 'Implemented rules need evidence.';
  if (kind === 'gap' && fields.status === 'closed' && !fields.closed_by) problems.closed_by = 'Name the closing decision or order.';
  if (row) {
    const original = row as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (JSON.stringify(fields[key]) === JSON.stringify(original[key])) delete fields[key];
  }
  return Object.keys(problems).length ? { problems } : { problems, changeset: { title: `${retire ? 'Retire' : row ? 'Update' : 'Create'} ${id}`, ...(decision.trim() ? { decision: decision.trim() } : {}), changes: [{ kind, id, op: retire ? 'retire' : row ? 'update' : 'create', ...(row ? { base_version: row.version } : {}), fields }] } };
}
