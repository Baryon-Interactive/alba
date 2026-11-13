import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateProject } from '../../src/config.ts';
import { stateStore } from '../../src/orders/backend.ts';
import { Orders } from '../../src/orders/service.ts';
import type { ChangeSet } from '../../src/design/model.ts';

export function designFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'alba-design-'));
  mkdirSync(path.join(root, 'orders')); mkdirSync(path.join(root, 'content'));
  writeFileSync(path.join(root, 'content/economy.json'), JSON.stringify({ gold: 7, unregistered: 11, 'a/b': { '~count': 2 }, enabled: true }));
  writeFileSync(path.join(root, 'rules.md'), '# Economy\nGold accumulates each turn.\n');
  const file = path.join(root, 'alba.yaml');
  writeFileSync(file, 'id: fixture\nname: Fixture\nroot: .\nwork_orders: orders\nstate_dir: state\nstate: { backend: sqlite }\ndesign: { enabled: true, data_roots: ["content/**/*.json"] }\n');
  const project = validateProject({ id: 'fixture', name: 'Fixture', root: '.', work_orders: 'orders', state_dir: 'state', state: { backend: 'sqlite' }, design: { enabled: true, data_roots: ['content/**/*.json'] } }, file);
  const orders = new Orders(stateStore(project));
  return { root, project, orders, file };
}
export function initialDesign(): ChangeSet {
  return { title: 'Economy baseline', changes: [
    { op: 'create', kind: 'system', id: 'ECON', fields: { name: 'Economy', summary: 'Gold flow', code_globs: ['src/economy/**'], source_refs: ['rules.md'] } },
    { op: 'create', kind: 'rule', id: 'ECON-R01', fields: { system: 'ECON', text: 'Gold accumulates each turn.', sources: [{ kind: 'doc', ref: 'rules.md' }] } },
    { op: 'create', kind: 'formula', id: 'ECON-F01', fields: { system: 'ECON', expression: 'gold + ECON.income.base', variables: ['gold', 'ECON.income.base'], number_kind: 'integer', rounding: 'none', timing: 'per turn' } },
    { op: 'create', kind: 'param', id: 'ECON.income.base', fields: { system: 'ECON', location: { file: 'content/economy.json', pointer: '/gold' }, meaning: 'Base income', unit: 'gold', type: 'int', range_min: 0, range_max: 10, source: 'baseline', source_ref: 'Initial balance', rules: ['ECON-R01'], formulas: ['ECON-F01'] } },
    { op: 'create', kind: 'target', id: 'ECON-T01', fields: { system: 'ECON', metric: 'Gold after one turn', min: 5, max: 10, unit: 'gold', command: 'node measure.mjs', last_value: 12, measured_commit: 'abc1234', measured_at: '2026-01-01T00:00:00Z', evidence: [{ kind: 'file', ref: 'rules.md' }] } },
    { op: 'create', kind: 'target', id: 'ECON-T02', fields: { system: 'ECON', metric: 'Turn time', max: 10, unit: 'ms', command: 'node measure.mjs' } },
    { op: 'create', kind: 'gap', id: 'ECON-G01', fields: { system: 'ECON', text: 'Add income measurement', refs: ['ECON-T02', 'ECON.income.base'] } },
    { op: 'create', kind: 'milestone', id: 'M-SLICE', fields: { name: 'Playable slice', position: 1, status: 'active', criteria: [{ target: 'ECON-T01' }, { target: 'ECON-T02' }, { text: 'A person checks the tutorial' }] } },
    { op: 'create', kind: 'term', id: 'gold', fields: { system: 'ECON', meaning: 'Spendable currency', avoid: ['score'] } },
  ] };
}
