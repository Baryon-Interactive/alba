import type { ProducerConfigEdit } from '@api';

/** The changed lines with a little context around them; unchanged runs longer than that collapse to "…". */
export function diffRows(diff: ProducerConfigEdit['diff'], context = 2): { op: ' ' | '-' | '+' | '…'; text: string }[] {
  const near = diff.map((_, i) => diff.slice(Math.max(0, i - context), i + context + 1).some(d => d.op !== ' '));
  const out: { op: ' ' | '-' | '+' | '…'; text: string }[] = [];
  diff.forEach((d, i) => { if (near[i]) out.push(d); else if (out.at(-1)?.op !== '…') out.push({ op: '…', text: '' }); });
  return out;
}
