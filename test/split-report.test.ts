import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProject } from '../src/config.ts';
import { validateReport } from '../src/orders/report.ts';
import { validateSubtasks } from '../src/orders/subtasks.ts';
import { tempOrders } from './helpers.ts';

test('split policy accepts a default or a policy by kind', () => {
  const config = (approve: unknown) => validateProject({ id: 'sample', name: 'Sample', root: '.', work_orders: '.', state_dir: '.', split: { approve } }, 'sample.yaml');
  assert.equal(config('auto').split?.approve, 'auto');
  assert.deepEqual(config({ feature: 'auto' }).split?.approve, { feature: 'auto' });
  assert.throws(() => config({ feature: true }), /split.approve/);
});

const body = '## Acceptance\n- Lookup returns the stored value.';
const item = { key: 'lookup', title: 'Lookup', kind: 'code', body };
const other = { ...item, key: 'store', needs: ['lookup'] };
test('a split validates every child and the complete sibling dependency graph', () => {
  assert.deepEqual(validateSubtasks([item, other], ['code']), [item, other]);
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...item, key: String(i) }));
  assert.equal(validateSubtasks(eight).length, 8);
  assert.equal(validateSubtasks([item, { ...other, body: body.padEnd(16383) }])[1].body.length, 16383);
  for (const invalid of [[item], [...eight, item], [item, item], [item, { ...other, needs: ['missing'] }],
    [{ ...item, needs: ['store'] }, other], [item, { ...other, kind: 'missing' }],
    [item, { ...other, body: '' }], [item, { ...other, body: 'No acceptance' }],
    [item, { ...other, body: body.padEnd(16384) }], [item, { ...other, body: body + '\u{1F331}'.repeat(4096) }],
    [item, { ...other, needs: 'lookup' }], [item, { ...other, needs: ['store'] }]]) {
    assert.throws(() => validateSubtasks(invalid, ['code']));
  }
});

test('a completed split report waits for a card and ordinary reports cannot propose children', () => {
  const { orders } = tempOrders();
  orders.add({ tag: 'CACHE', title: 'Cache', kind: 'feature' });
  const report = validateReport({ status: 'ready', summary: 'Divide cache work', subtasks: [item, other] });
  assert.throws(() => orders.report('CACHE', report));
  orders.runStart('CACHE', { worker: 'reader', extra: { phase: 'divide', next_phase: 'assemble', split_kinds: ['code'] } });
  orders.report('CACHE', report);
  assert.equal(orders.stage(orders.get('CACHE')).stage, 'running');
  orders.runEnd('CACHE');
  assert.equal(orders.stage(orders.get('CACHE')).waitingFor, 'card');
});
