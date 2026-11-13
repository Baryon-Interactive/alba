import { describe, expect, it } from 'vitest';
import { buildChange, formOf, liveParams, paramsCsv, schema, searchEntities, systemHistory, systemStats, targetState } from './design';
import { seedDesign } from '@/mocks/design-data';
import { zh } from '@/i18n/zh';

describe('design library projections', () => {
  const data = seedDesign();
  it('counts active rules, each target state and gaps with and without orders', () => {
    expect(systemStats(data, 'GLD')).toEqual({ rules: { done: 1, partial: 1, none: 1 }, formulas: 1, params: 2, passing: 1, failing: 1, unmeasured: 1, assigned: 1, unassigned: 1 });
    expect(data.target.map(targetState)).toEqual(['failing', 'passing', 'unmeasured']);
    expect(targetState({ ...data.target[0], last_value: 80 })).toBe('passing');
  });
  it('searches formulas, terms, milestones and every entity kind', () => {
    expect(searchEntities(data, 'thermal_strength').map(h => h.kind)).toContain('formula');
    expect(searchEntities(data, 'boost zone').map(h => h.kind)).toContain('term');
    expect(searchEntities(data, 'First flight').map(h => h.kind)).toContain('milestone');
  });
  it('exports resolved live values, escapes quotes and prevents spreadsheet formulas', () => {
    const csv = paramsCsv(liveParams(data, 'GLD').map(p => ({ ...p, meaning: '=1+2,"test"' })));
    expect(csv).toContain('"11.5"');
    expect(csv).toContain('"\'=1+2,""test"""');
    expect(csv).toContain('"/glider/lift"');
    expect(systemHistory(data, 'TRV')).toEqual([]);
    expect(systemHistory({ ...data, history: [...data.history, { ...data.history[0], id: 2 }] }, 'GLD').map(h => h.id)).toEqual([2, 1]);
  });
});
describe('design forms', () => {
  const data = seedDesign();
  it('builds patches with base_version, optional decision, and no live parameter value', () => {
    const param = { ...data.param[0], value: 11.5 };
    const form = { ...formOf('param', param), meaning: 'Lift acceleration in a thermal' };
    const result = buildChange('param', form, param, false, 'DEC700');
    expect(result.problems).toEqual({});
    expect(result.changeset?.changes[0]).toEqual({ kind: 'param', id: param.id, op: 'update', base_version: 1, fields: { meaning: 'Lift acceleration in a thermal' } });
    expect(result.changeset?.decision).toBe('DEC700');
  });
  it('creates entities without base_version and retires only with a replacement', () => {
    const form = { ...formOf('rule', data.rule[0]), id: 'GLD-R09' };
    expect(buildChange('rule', form).changeset?.changes[0].base_version).toBeUndefined();
    expect(buildChange('rule', form, data.rule[0], true).problems.superseded_by).toBeTruthy();
    expect(buildChange('rule', { ...form, superseded_by: 'GLD-R02' }, data.rule[0], true).changeset?.changes[0].op).toBe('retire');
  });
  it('reports field errors for bounds, invalid JSON, dates and missing measurement provenance', () => {
    expect(buildChange('param', { ...formOf('param', data.param[0]), range_max: '1', location: '[]' }, data.param[0]).problems).toMatchObject({ range_max: expect.any(String), location: expect.any(String) });
    expect(buildChange('target', { ...formOf('target', data.target[0]), measured_at: '', evidence: '[]' }, data.target[0]).problems.last_value).toBeTruthy();
    expect(buildChange('system', { ...formOf('system', data.system[0]), verified_at: 'invalid' }, data.system[0]).problems.verified_at).toBeTruthy();
  });
  it('validates structured fields and implemented rule evidence per field', () => {
    expect(buildChange('rule', { ...formOf('rule', data.rule[0]), sources: '[{"kind":"wrong","ref":"docs/game.md"}]', evidence: '[]' }, data.rule[0]).problems).toMatchObject({ sources: expect.any(String), evidence: expect.any(String) });
    expect(buildChange('milestone', { ...formOf('milestone', data.milestone[0]), criteria: '[{"target":"GLD-T01","text":"extra"}]' }, data.milestone[0]).problems.criteria).toBeTruthy();
  });
  it('has Chinese entries for dynamic field labels and every selectable value', () => {
    for (const field of Object.values(schema).flat()) {
      expect(zh[field.label], field.label).toBeTruthy();
      for (const value of field.choices ?? []) expect(zh[value], value).toBeTruthy();
    }
  });
});
