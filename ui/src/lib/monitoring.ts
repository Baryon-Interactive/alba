import type { MonitorCriterion, MonitorView, ProgressView } from '@api';
import type { Tone } from '@/components/ui/badge';
import { t } from '@/i18n';
import { minutes } from './format.ts';

/** One condition of a monitor in words. */
export const criterionText = (c: MonitorCriterion): string =>
  'exit_code' in c ? t('the check exits with {code}', { code: c.exit_code })
    : 'file_exists' in c ? t('the file {path} exists', { path: c.file_exists })
      : t('the output matches {pattern}', { pattern: c.output_matches });

/** What the last check found. */
export const monitorResultLabel = (r: MonitorView['lastResult']): string => {
  switch (r) {
    case 'done': return t('condition met');
    case 'failed': return t('failure condition met');
    case 'deadline': return t('deadline passed');
    case 'refused': return t('check refused: its folder is not allowed');
    default: return t('waiting');
  }
};

export const monitorResultTone = (r: MonitorView['lastResult']): Tone => (r === 'done' ? 'success' : r === 'failed' || r === 'refused' ? 'danger' : r === 'deadline' ? 'warning' : 'neutral');

/** How long until the order is continued whatever the check says. */
export function deadlineText(deadline: string, now = Date.now()): string {
  const left = (Date.parse(deadline) - now) / 60000;
  return left > 0 ? t('{time} left', { time: minutes(left) }) : t('past the deadline');
}

/** The check, as a person would type it. */
export const checkLine = (spec: MonitorView['spec']): string => spec.check.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** "step 3/7" for the card: the step in hand is the one after those done; all steps done says so. Nothing when the worker listed no steps. */
export function stepText(p: ProgressView | undefined): string | undefined {
  if (!p || p.total === 0) return undefined;
  return p.done >= p.total ? t('all {total} steps done', { total: p.total }) : t('step {n}/{total}', { n: p.done + 1, total: p.total });
}

/** Resource use as a share, for the bar: 0 to 100. */
export const usedPercent = (used: number, slots: number): number => (slots > 0 ? Math.min(100, Math.round((used / slots) * 100)) : 0);
