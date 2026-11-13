import { beforeAll, describe, expect, it } from 'vitest';
import type { ProgressView } from '@api';
import { setLang } from '@/i18n';
import { checkLine, criterionText, deadlineText, monitorResultTone, stepText, usedPercent } from './monitoring.ts';

beforeAll(() => setLang('en'));

const progress = (done: number, total: number): ProgressView => ({ plan: [], done, total, at: '2026-01-01T00:00:00Z' });

describe('the step count on a card', () => {
  it('shows the step in hand: one after the ones done', () => {
    expect(stepText(progress(2, 7))).toBe('step 3/7');
    expect(stepText(progress(0, 4))).toBe('step 1/4');
  });
  it('says all done when every step is, and nothing when the worker listed none', () => {
    expect(stepText(progress(7, 7))).toBe('all 7 steps done');
    expect(stepText(progress(0, 0))).toBeUndefined();
    expect(stepText(undefined)).toBeUndefined();
  });
});

describe('a monitor in words', () => {
  it('names each kind of condition', () => {
    expect(criterionText({ exit_code: 0 })).toBe('the check exits with 0');
    expect(criterionText({ file_exists: 'out/Game.exe' })).toBe('the file out/Game.exe exists');
    expect(criterionText({ output_matches: 'FATAL' })).toBe('the output matches FATAL');
  });
  it('quotes only the words of the check that need it', () => {
    expect(checkLine({ check: ['python', 'tools/a b.py', '--json'], done_when: { exit_code: 0 }, deadline_minutes: 5 })).toBe('python "tools/a b.py" --json');
  });
  it('counts down to the deadline, then says it passed', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(deadlineText('2026-01-01T01:24:00Z', now)).toBe('1 h 24 min left');
    expect(deadlineText('2025-12-31T23:00:00Z', now)).toBe('past the deadline');
  });
  it('colours a refused or failed check as a problem and a waiting one as nothing special', () => {
    expect([monitorResultTone('refused'), monitorResultTone('failed'), monitorResultTone('waiting'), monitorResultTone(undefined), monitorResultTone('done')]).toEqual(['danger', 'danger', 'neutral', 'neutral', 'success']);
  });
});

describe('resource bars', () => {
  it('is the share of slots held, never past full', () => {
    expect([usedPercent(2, 3), usedPercent(5, 3), usedPercent(0, 2), usedPercent(1, 0)]).toEqual([67, 100, 0, 0]);
  });
});
