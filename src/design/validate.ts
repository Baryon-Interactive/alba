import type { ProjectConfig } from '../config.ts';
import { existsSync, readFileSync } from 'node:fs';
import { backendName, stateStore } from '../orders/backend.ts';
import { chunkMarkdown } from './docs.ts';
import { validateMeasure } from './measure-validate.ts';
import { parseDecisionId, readLedger } from '../ledger/decisions.ts';
import type { Orders } from '../orders/service.ts';
import { codeRefError, JsonDataCache, projectFile, relativePath, resolveParam, typeMatches, outsideRange } from './files.ts';
import { DESIGN_KINDS, PARAM_TYPES, DesignError, entityId, type ChangeSet, type DesignKind, type Entity, type Library, type Issue, type Param } from './model.ts';

const fields: Record<DesignKind, string[]> = {
  system: ['code', 'name', 'summary', 'status', 'source_refs', 'code_globs', 'data_globs', 'verified_commit', 'verified_at'],
  rule: ['id', 'system', 'text', 'sources', 'status', 'superseded_by', 'implementation', 'evidence'],
  formula: ['id', 'system', 'expression', 'variables', 'number_kind', 'rounding', 'timing', 'code_refs', 'notes'],
  param: ['id', 'system', 'location', 'meaning', 'unit', 'type', 'range_min', 'range_max', 'source', 'source_ref', 'rules', 'formulas'],
  target: ['id', 'system', 'metric', 'min', 'max', 'unit', 'command', 'measure', 'last_value', 'measured_commit', 'measured_at', 'evidence'],
  gap: ['id', 'system', 'text', 'refs', 'order', 'status', 'closed_by'],
  milestone: ['id', 'name', 'position', 'status', 'systems', 'criteria'], term: ['term', 'meaning', 'avoid', 'system'], decision_link: ['decision', 'kind', 'entity'],
};
const defaults: Record<DesignKind, Record<string, unknown>> = {
  system: { status: 'not-started', source_refs: [], code_globs: [], data_globs: [], verified_commit: null, verified_at: null },
  rule: { status: 'active', superseded_by: null, implementation: 'none', evidence: [] },
  formula: { variables: [], code_refs: [], notes: '' },
  param: { range_min: null, range_max: null, rules: [], formulas: [] },
  target: { min: null, max: null, last_value: null, measured_commit: null, measured_at: null, evidence: [] },
  gap: { refs: [], order: null, status: 'open', closed_by: null }, milestone: { status: 'not-started', criteria: [] }, term: { avoid: [], system: null }, decision_link: {},
};
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function reject(text: string): never { throw new DesignError(text); }
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const list = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonempty);
const oneOf = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const SYS = '[A-Z][A-Z0-9]{1,11}';

/** Resolve numeric aliases through ledger entries; persist the existing canonical Alba id. */
export function normalizeDecisions(project: ProjectConfig, set: ChangeSet, library?: Library, orders?: Orders): void {
  if (!project.decisions) return;
  const cfg = project.decisions, ledger = readLedger(cfg), orderIds = new Set(orders?.all().map(d => d.order.tag));
  const resolve = (id: unknown): unknown => {
    if (typeof id !== 'string') return id;
    const found = ledger.find(d => d.id === id) ?? ledger.find(d => d.number === parseDecisionId(cfg, id));
    return found ? `${cfg.id_prefix}${found.number}` : id;
  };
  if (set.decision) set.decision = resolve(set.decision) as string;
  for (const c of set.changes) {
    const f = c.fields;
    if (c.kind === 'rule') {
      if (Array.isArray(f.sources)) for (const s of f.sources) if (record(s) && s.kind === 'decision') s.ref = resolve(s.ref);
      if (f.superseded_by) f.superseded_by = resolve(f.superseded_by);
    }
    if (c.kind === 'param' && (f.source ?? library?.param.find(p => p.id === c.id)?.source) === 'decision' && f.source_ref) f.source_ref = resolve(f.source_ref);
    if (c.kind === 'gap' && f.closed_by && !orderIds.has(f.closed_by as string)) f.closed_by = resolve(f.closed_by);
    if (c.kind === 'decision_link') {
      if (f.decision) f.decision = resolve(f.decision);
      const [decision, ...rest] = c.id.split(':'); c.id = [resolve(decision), ...rest].join(':');
    }
  }
}

export function parseChangeSet(raw: unknown): ChangeSet {
  if (!record(raw) || !nonempty(raw.title) || Object.keys(raw).some(k => !['title', 'decision', 'order', 'changes'].includes(k))) reject('A change set needs a title, optional decision/order, and changes.');
  for (const key of ['decision', 'order']) if (raw[key] !== undefined && !nonempty(raw[key])) reject(`${key} must be a nonempty string.`);
  if (!Array.isArray(raw.changes) || !raw.changes.length) reject('A change set needs at least one change.');
  const seen = new Set<string>();
  for (const value of raw.changes) {
    if (!record(value) || !oneOf(value.op, ['create', 'update', 'retire']) || !oneOf(value.kind, DESIGN_KINDS) || !nonempty(value.id) || !record(value.fields) || Object.keys(value).some(k => !['op', 'kind', 'id', 'base_version', 'fields'].includes(k))) reject('Each change needs op, kind, id, fields and (for updates) base_version.');
    if (value.op !== 'create' && (typeof value.base_version !== 'number' || !Number.isSafeInteger(value.base_version) || value.base_version < 1)) reject(`${value.id}: update/retire needs base_version.`);
    if (value.op === 'create' && value.base_version !== undefined) reject(`${value.id}: create must omit base_version.`);
    if (value.op === 'retire' && value.kind !== 'rule') reject('Only rules can be retired; close gaps or update other statuses instead.');
    const key = `${value.kind}:${value.id}`;
    if (seen.has(key)) reject(`Duplicate entity in change set: ${key}`);
    seen.add(key);
    if (Object.keys(value.fields).some(k => !fields[value.kind as DesignKind].includes(k))) reject(`${key}: unknown or read-only field (parameter values are never stored).`);
  }
  return structuredClone(raw) as unknown as ChangeSet;
}

export function nextEntity(kind: DesignKind, id: string, input: Record<string, unknown>, before: Entity | undefined, at: string, retire: boolean): Entity {
  const identity = kind === 'system' ? { code: id } : kind === 'term' ? { term: id } : kind === 'decision_link' ? {} : { id };
  const row = { ...defaults[kind], ...before, ...identity, ...input, version: (before?.version ?? 0) + 1, updated: at, ...(retire ? { status: 'retired' } : {}) } as unknown as Entity;
  if (entityId(kind, row) !== id) reject(`${kind}:${id}: identity cannot change.`);
  if (before && 'system' in before && (row as { system?: string }).system !== before.system) reject(`${id}: system cannot change.`);
  if (kind === 'rule' && before && 'status' in before && before.status === 'retired' && (row as { status: string }).status !== 'retired') reject(`${id}: retired rules cannot be reactivated.`);
  return row;
}

/** Validate edits against the combined graph, without revalidating unrelated stored fields. */
export function validateLibrary(project: ProjectConfig, orders: Orders, library: Library, sets: ChangeSet[], cache = new JsonDataCache()): Issue[] {
  const warnings: Issue[] = [], decisions = new Set(project.decisions ? readLedger(project.decisions).map(d => d.id) : []);
  const changed = new Set(sets.flatMap(s => s.changes.map(c => `${c.kind}:${c.id}`)));
  const retired = new Set(sets.flatMap(s => s.changes.filter(c => c.op === 'retire' || (c.kind === 'rule' && c.fields.status === 'retired')).map(c => c.id)));
  const orderDocs = orders.all(), orderIds = new Set(orderDocs.map(d => d.order.tag));
  const has = (kind: DesignKind, id: string) => library[kind].some(r => entityId(kind, r) === id);
  const ref = (kind: DesignKind, id: unknown) => { if (!nonempty(id) || !has(kind, id)) reject(`Unresolved ${kind} reference: ${String(id)}`); };
  const liveRule = (id: string) => { ref('rule', id); if (library.rule.find(r => r.id === id)?.status === 'retired') reject(`Reference to retired rule: ${id}`); };
  const decision = (id: unknown) => { if (!nonempty(id) || !decisions.has(id)) reject(`Unresolved decision: ${String(id)}`); };
  const order = (id: unknown) => { if (!nonempty(id) || !orderIds.has(id)) reject(`Unresolved order: ${String(id)}`); };
  const doc = (id: string) => {
    const ref = /^([^@#]+)@(\d+)#(.+)$/.exec(id);
    if (ref) {
      const configured = project.design_docs?.files.find(d => d.id === ref[1]);
      if (configured) { try { const file = project.root + '/' + (configured.path ?? ''); if (!existsSync(file)) throw new Error(`file ${configured.path} does not exist`); const blocks = chunkMarkdown(readFileSync(file, 'utf8')); if (!blocks.some(block => block.id === ref[3])) throw new Error(`block ${ref[3]} does not exist`); return; } catch (e) { reject(`Unresolved document ${id}: ${(e as Error).message}`); } }
      if (backendName(project) === 'sqlite') {
        try { const store = stateStore(project) as import('../orders/sqlite-store.ts').SqliteStore; const row = store.db.prepare('SELECT blocks FROM design_doc_versions WHERE doc_id = ? AND version = ?').get(ref[1], Number(ref[2])) as { blocks?: string } | undefined; if (row && JSON.parse(row.blocks ?? '[]').some((block: { id?: string }) => block.id === ref[3])) return; } catch { /* fall through to the normal error */ }
      }
      reject(`Unresolved document ${id}`);
    }
    try { projectFile(project.root, id.split('#')[0]); } catch (e) { reject(`Unresolved document ${id}: ${(e as Error).message}`); }
  };
  const evidence = (v: unknown) => {
    if (!Array.isArray(v)) reject('evidence must be a list.');
    for (const e of v) {
      if (!record(e) || Object.keys(e).some(k => !['kind', 'ref'].includes(k)) || !oneOf(e.kind, ['order', 'file', 'report']) || !nonempty(e.ref)) reject('Evidence needs kind order|file|report and ref.');
      if (e.kind === 'file') doc(e.ref);
      if (e.kind === 'order') order(e.ref);
      if (e.kind === 'report') {
        const [tag, run] = e.ref.split('#'); order(tag);
        if (!orderDocs.find(d => d.order.tag === tag)?.reports.some(r => !run || r.run === run)) reject(`Unresolved report: ${e.ref}`);
      }
    }
  };
  for (const set of sets) {
    if (set.decision) decision(set.decision);
    if (set.order) order(set.order);
  }
  for (const kind of DESIGN_KINDS) for (const entity of library[kind]) {
    const r = entity as unknown as Record<string, unknown>, id = entityId(kind, entity);
    if (!changed.has(`${kind}:${id}`)) {
      // Only references whose destinations this batch changes can invalidate an unchanged row.
      if ('system' in entity && entity.system && changed.has(`system:${entity.system}`)) ref('system', entity.system);
      const rules = kind === 'param' ? (entity as Param).rules : kind === 'gap' ? library.gap.find(g => g.id === id)!.refs : kind === 'decision_link' && r.kind === 'rule' ? [r.entity] : [];
      for (const rule of rules) if (typeof rule === 'string' && retired.has(rule)) liveRule(rule);
      continue;
    }
    const text = (...keys: string[]) => { for (const k of keys) if (!nonempty(r[k])) reject(`${id}: ${k} must be nonempty text.`); };
    const strings = (...keys: string[]) => { for (const k of keys) if (!list(r[k])) reject(`${id}: ${k} must be a list of nonempty strings.`); };
    const choice = (key: string, options: readonly string[]) => { if (!oneOf(r[key], options)) reject(`${id}: ${key} must be ${options.join('|')}.`); };
    const nullableNumber = (...keys: string[]) => { for (const k of keys) if (r[k] !== null && (typeof r[k] !== 'number' || !Number.isFinite(r[k]))) reject(`${id}: ${k} must be a finite number or null.`); };
    const nullableText = (...keys: string[]) => { for (const k of keys) if (r[k] !== null && !nonempty(r[k])) reject(`${id}: ${k} must be nonempty text or null.`); };
    const timestamp = (key: string) => { nullableText(key); if (r[key] !== null && !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r[key] as string)) reject(`${id}: ${key} must be an ISO timestamp.`); if (r[key] !== null && !Number.isFinite(Date.parse(r[key] as string))) reject(`${id}: invalid ${key}.`); };
    if (kind === 'system') { if (!new RegExp(`^${SYS}$`).test(id)) reject(`Invalid system code: ${id}`); }
    else if (['rule', 'formula', 'target', 'gap'].includes(kind)) {
      const letter = { rule: 'R', formula: 'F', target: 'T', gap: 'G' }[kind as 'rule'];
      if (!new RegExp(`^${SYS}-${letter}\\d{2,}$`).test(id) || !id.startsWith(`${r.system}-`)) reject(`Invalid ${kind} id or system: ${id}`);
    } else if (kind === 'param' && (!new RegExp(`^${SYS}\\.[a-z_]+\\.[a-z_]+$`).test(id) || !id.startsWith(`${r.system}.`))) reject(`Invalid parameter id or system: ${id}`);
    else if (kind === 'milestone' && !/^M-[A-Z][A-Z0-9_-]*$/.test(id)) reject(`Invalid milestone id: ${id}`);
    if (['rule', 'formula', 'param', 'target', 'gap'].includes(kind) || (kind === 'term' && r.system !== null)) ref('system', r.system);
    if (kind === 'system') {
      text('name', 'summary'); choice('status', ['not-started', 'prototype', 'playable', 'done']); strings('source_refs', 'code_globs', 'data_globs');
      for (const s of r.source_refs as string[]) doc(s);
      for (const g of [...r.code_globs as string[], ...r.data_globs as string[]]) if (!relativePath(g)) reject(`${id}: globs must stay inside the project.`);
      nullableText('verified_commit'); timestamp('verified_at');
      if ((r.verified_commit === null) !== (r.verified_at === null)) reject(`${id}: verified_commit and verified_at must be provided together.`);
    } else if (kind === 'rule') {
      text('text'); choice('status', ['active', 'retired']); choice('implementation', ['none', 'partial', 'done']); nullableText('superseded_by');
      if (!Array.isArray(r.sources) || !r.sources.length) reject(`${id}: a rule needs a source.`);
      for (const s of r.sources) {
        if (!record(s) || Object.keys(s).some(k => !['kind', 'ref'].includes(k)) || !oneOf(s.kind, ['decision', 'doc']) || !nonempty(s.ref)) reject(`${id}: invalid source.`);
        if (s.kind === 'decision') decision(s.ref); else doc(s.ref);
      }
      evidence(r.evidence);
      if (r.implementation !== 'none' && !(r.evidence as unknown[]).length) reject(`${id}: implemented rules need evidence.`);
      if (r.status === 'retired') { text('superseded_by'); if (r.superseded_by === id) reject(`${id}: cannot supersede itself.`); if (!decisions.has(r.superseded_by as string)) ref('rule', r.superseded_by); }
    } else if (kind === 'formula') {
      text('expression', 'rounding', 'timing'); strings('variables', 'code_refs'); choice('number_kind', ['integer', 'fixed', 'float']); if (typeof r.notes !== 'string') reject(`${id}: notes must be text.`);
      for (const v of r.variables as string[]) { if (new RegExp(`^${SYS}\\.`).test(v)) ref('param', v); else if (!/^[a-zA-Z_][\w.]*(?:\[\d+\])?$/.test(v)) reject(`${id}: invalid named state field ${v}`); }
      for (const code of r.code_refs as string[]) { const error = codeRefError(project.root, code); if (error) reject(`${id}: ${error}`); }
    } else if (kind === 'param') {
      text('meaning', 'unit', 'source_ref'); choice('type', PARAM_TYPES); choice('source', ['baseline', 'decision', 'tuned']); nullableNumber('range_min', 'range_max'); strings('rules', 'formulas');
      if (!record(r.location) || Object.keys(r.location).some(k => !['file', 'pointer'].includes(k)) || !nonempty(r.location.file) || typeof r.location.pointer !== 'string') reject(`${id}: location needs file and pointer.`);
      if (r.source === 'decision') decision(r.source_ref);
      for (const rule of r.rules as string[]) liveRule(rule);
      for (const formula of r.formulas as string[]) ref('formula', formula);
      const p = entity as Param;
      let value: unknown; try { value = resolveParam(project.root, p, cache); } catch (e) { reject(`${id}: ${(e as Error).message}`); }
      if (!typeMatches(p.type, value)) reject(`${id}: value does not match type ${p.type}.`);
      if (outsideRange(value, p.range_min, p.range_max)) warnings.push({ severity: 'warning', code: 'param-range', entity: id, message: `${id}: live value is outside range.` });
      if (p.range_min !== null && p.range_max !== null && p.range_min > p.range_max) reject(`${id}: range_min exceeds range_max.`);
    } else if (kind === 'target') {
      validateMeasure(r.measure, project);
      text('metric', 'unit', 'command'); nullableNumber('min', 'max', 'last_value'); nullableText('measured_commit'); timestamp('measured_at'); evidence(r.evidence);
      if (r.min === null && r.max === null) reject(`${id}: a target needs min or max.`);
      if (r.min !== null && r.max !== null && (r.min as number) > (r.max as number)) reject(`${id}: min exceeds max.`);
      if (r.last_value !== null && (r.measured_commit === null || r.measured_at === null || !(r.evidence as unknown[]).length)) reject(`${id}: measurements need commit, time and evidence.`);
    } else if (kind === 'gap') {
      text('text'); strings('refs'); choice('status', ['open', 'closed']); nullableText('order', 'closed_by'); if (r.order !== null) order(r.order);
      for (const v of r.refs as string[]) { if (!['rule', 'target', 'param'].some(k => has(k as DesignKind, v))) reject(`${id}: unresolved gap ref ${v}`); if (has('rule', v)) liveRule(v); }
      if (r.status === 'closed') { text('closed_by'); if (!decisions.has(r.closed_by as string)) order(r.closed_by); }
    } else if (kind === 'milestone') {
      if (r.systems !== undefined) { strings('systems'); for (const system of r.systems as string[]) ref('system', system); }
      text('name'); choice('status', ['not-started', 'active', 'done']); if (typeof r.position !== 'number' || !Number.isSafeInteger(r.position)) reject(`${id}: position must be an integer.`);
      if (!Array.isArray(r.criteria)) reject(`${id}: criteria must be a list.`);
      for (const c of r.criteria) { if (!record(c) || Object.keys(c).length !== 1) reject(`${id}: each criterion needs target or text.`); if (c.target !== undefined) ref('target', c.target); else if (!nonempty(c.text)) reject(`${id}: criterion text must be nonempty.`); }
    } else if (kind === 'term') { text('term', 'meaning'); strings('avoid'); if (id.length > 200) reject('Term is too long.'); }
    else if (kind === 'decision_link') { decision(r.decision); choice('kind', DESIGN_KINDS.filter(k => k !== 'decision_link')); ref(r.kind as DesignKind, r.entity); }
  }
  if (library.milestone.filter(m => m.status === 'active').length > 1) reject('Only one milestone may be active.');
  return warnings;
}
