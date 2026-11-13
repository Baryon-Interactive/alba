export const DESIGN_KINDS = ['system', 'rule', 'formula', 'param', 'target', 'gap', 'milestone', 'term', 'decision_link'] as const;
export type DesignKind = typeof DESIGN_KINDS[number];
export type DesignOp = 'create' | 'update' | 'retire';
export interface Stamp { version: number; updated: string }
export interface System extends Stamp { code: string; name: string; summary: string; status: 'not-started' | 'prototype' | 'playable' | 'done'; source_refs: string[]; code_globs: string[]; data_globs: string[]; verified_commit: string | null; verified_at: string | null }
export interface Rule extends Stamp { id: string; system: string; text: string; sources: { kind: 'decision' | 'doc'; ref: string }[]; status: 'active' | 'retired'; superseded_by: string | null; implementation: 'none' | 'partial' | 'done'; evidence: Evidence[] }
export interface Formula extends Stamp { id: string; system: string; expression: string; variables: string[]; number_kind: 'integer' | 'fixed' | 'float'; rounding: string; timing: string; code_refs: string[]; notes: string }
export const PARAM_TYPES = ['int', 'permille', 'milli', 'float', 'bool', 'string'] as const;
export interface Param extends Stamp { id: string; system: string; location: { file: string; pointer: string }; meaning: string; unit: string; type: typeof PARAM_TYPES[number]; range_min: number | null; range_max: number | null; source: 'baseline' | 'decision' | 'tuned'; source_ref: string; rules: string[]; formulas: string[] }
export interface Evidence { kind: 'order' | 'file' | 'report'; ref: string }
export interface Measure { argv: string[]; cwd?: string; timeout_minutes: number; uses?: string[]; kind?: string; value: { json_pointer: string; file?: string } | { regex: string; group: number }; when: { after_merge_paths?: string[]; every_hours?: number } }
export interface MeasurementResult { target: string; at: string; commit: string; status: 'ok' | 'failed'; reason?: string; value?: number; log: string; merge?: string; definition: string }
export interface MeasurementView { target: string; due: boolean; last?: MeasurementResult; running: boolean }
export interface Target extends Stamp { id: string; system: string; metric: string; min: number | null; max: number | null; unit: string; command: string; measure?: Measure | null; last_value: number | null; measured_commit: string | null; measured_at: string | null; evidence: Evidence[] }
export interface Gap extends Stamp { id: string; system: string; text: string; refs: string[]; order: string | null; status: 'open' | 'closed'; closed_by: string | null }
export interface Milestone extends Stamp { id: string; name: string; position: number; status: 'not-started' | 'active' | 'done'; systems?: string[]; criteria: ({ target: string } | { text: string })[] }
export interface Term extends Stamp { term: string; meaning: string; avoid: string[]; system: string | null }
export interface DecisionLink extends Stamp { decision: string; kind: Exclude<DesignKind, 'decision_link'>; entity: string }
export interface DesignEntities { system: System; rule: Rule; formula: Formula; param: Param; target: Target; gap: Gap; milestone: Milestone; term: Term; decision_link: DecisionLink }
export type Entity = DesignEntities[DesignKind];
export type Library = { [K in DesignKind]: DesignEntities[K][] };
export interface Change { op: DesignOp; kind: DesignKind; id: string; base_version?: number; fields: Record<string, unknown> }
export interface ChangeSet { title: string; decision?: string; order?: string; changes: Change[] }
export interface History { id: number; at: string; kind: DesignKind; entity: string; op: DesignOp; before: Entity | null; after: Entity; by: 'web' | 'cli' | 'accept' | 'measure'; order: string | null; decision: string | null; changeset: string }
export interface Issue { severity: 'error' | 'warning'; code: string; entity: string; message: string; count?: number }
export const entityId = (kind: DesignKind, entity: Entity): string => kind === 'system' ? (entity as System).code : kind === 'term' ? (entity as Term).term : kind === 'decision_link' ? `${(entity as DecisionLink).decision}:${(entity as DecisionLink).kind}:${(entity as DecisionLink).entity}` : (entity as Rule).id;
export const emptyLibrary = (): Library => Object.fromEntries(DESIGN_KINDS.map(k => [k, []])) as unknown as Library;
export class DesignError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const DESIGN_OFF = 'Design library is off. Add design: { enabled: true } to the project configuration.';
