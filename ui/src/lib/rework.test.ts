import { describe, expect, it } from 'vitest';
import { buildReworkNote } from './rework.ts';

describe('rework note from diff comments', () => {
  it('is empty when there is nothing to say', () => {
    expect(buildReworkNote('  ', [])).toBe('');
    expect(buildReworkNote('', [{ file: 'a.ts', line: 1, side: 'new', text: '   ' }])).toBe('');
  });

  it('puts the general remark first, then the comments grouped by file in file and line order', () => {
    const note = buildReworkNote('Keep the public API as it was.', [
      { file: 'src/b.ts', line: 20, side: 'new', text: 'Rename this.' },
      { file: 'src/a.ts', line: 9, side: 'new', text: 'Missing null check' },
      { file: 'src/a.ts', line: 3, side: 'old', text: 'Do not remove this' },
    ]);
    expect(note).toBe([
      'Keep the public API as it was.',
      '',
      'src/a.ts:',
      '- line 3 (before the change): Do not remove this',
      '- line 9: Missing null check',
      'src/b.ts:',
      '- line 20: Rename this.',
    ].join('\n'));
  });

  it('keeps a multi-line comment on one line so that the list stays readable', () => {
    expect(buildReworkNote('', [{ file: 'x.ts', line: 5, side: 'new', text: 'first\n  second' }])).toBe('x.ts:\n- line 5: first second');
  });
});
