import type { ChangeSet } from './model.ts';

/** Create the referenced files and illustrative ledger decision before applying. */
export function designTemplate(): ChangeSet {
  return { title: 'Economy baseline', decision: 'D9001', changes: [
    { op: 'create', kind: 'system', id: 'ECON', fields: { name: 'Economy', summary: 'Currency and income', source_refs: ['docs/design.md'], code_globs: ['src/economy/**'], data_globs: ['content/economy.json'] } },
    { op: 'create', kind: 'rule', id: 'ECON-R01', fields: { system: 'ECON', text: 'Income is credited once per turn.', sources: [{ kind: 'decision', ref: 'D9001' }] } },
    { op: 'create', kind: 'formula', id: 'ECON-F01', fields: { system: 'ECON', expression: 'gold + ECON.income.base', variables: ['gold', 'ECON.income.base'], number_kind: 'integer', rounding: 'none', timing: 'per turn', code_refs: [], notes: '' } },
    { op: 'create', kind: 'param', id: 'ECON.income.base', fields: { system: 'ECON', location: { file: 'content/economy.json', pointer: '/income/base' }, meaning: 'Income each turn', unit: 'gold', type: 'int', range_min: 0, range_max: 100, source: 'decision', source_ref: 'D9001', rules: ['ECON-R01'], formulas: ['ECON-F01'] } },
    { op: 'create', kind: 'target', id: 'ECON-T01', fields: { system: 'ECON', metric: 'Turn calculation time', min: 0, max: 10, unit: 'ms', command: 'node tools/measure-economy.mjs' } },
    { op: 'create', kind: 'gap', id: 'ECON-G01', fields: { system: 'ECON', text: 'Add measurement command', refs: ['ECON-T01'], order: null } },
    { op: 'create', kind: 'milestone', id: 'M-SLICE', fields: { name: 'Playable slice', position: 1, status: 'active', criteria: [{ target: 'ECON-T01' }, { text: 'Review the first turn' }] } },
    { op: 'create', kind: 'term', id: 'gold', fields: { system: 'ECON', meaning: 'Spendable currency', avoid: ['score'] } },
    { op: 'create', kind: 'decision_link', id: 'D9001:rule:ECON-R01', fields: { decision: 'D9001', kind: 'rule', entity: 'ECON-R01' } },
  ] };
}
