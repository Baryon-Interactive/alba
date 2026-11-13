import { expect, it } from 'vitest';
import { diffRows } from './producer-settings';

it('producer settings diff: changed lines keep two lines of context, longer unchanged runs fold to one mark', () => {
  const same = (text: string) => ({ op: ' ' as const, text });
  const diff = [same('a'), same('b'), same('c'), same('d'), { op: '-' as const, text: 'enabled: false' }, { op: '+' as const, text: 'enabled: true' }, same('e'), same('f'), same('g'), same('h')];
  expect(diffRows(diff).map(r => r.op + r.text)).toEqual(['…', ' c', ' d', '-enabled: false', '+enabled: true', ' e', ' f', '…']);
  expect(diffRows([same('x')])).toEqual([{ op: '…', text: '' }]);
});
