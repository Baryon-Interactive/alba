import type { Route, RouteCandidate, Routing, SkillLayer } from '@api';
import { t } from '@/i18n';
import type { Tone } from '@/components/ui/badge';

export const verdictLabel = (v: RouteCandidate['verdict']) =>
  v === 'chosen' ? t('chosen') : v === 'passed-over' ? t('passed over') : v === 'unavailable' ? t('cannot start now') : t('does not take it');

export const verdictTone = (v: RouteCandidate['verdict']): Tone => (v === 'chosen' ? 'success' : v === 'passed-over' ? 'neutral' : v === 'unavailable' ? 'warning' : 'danger');

export const sourceLabel = (s: Routing['source']) =>
  s === 'table' ? t('dispatch table') : s === 'manual' ? t('given by a person') : s === 'rules' ? t('rules') : s === 'model' ? t('classifier worker') : t('not classified');

export const outcomeLabel = (o: Route['outcome']) =>
  o === 'chosen' ? t('a worker is chosen') : o === 'nobody-fits' ? t('nobody takes it') : t('all that take it are busy or out of quota');

export const outcomeTone = (o: Route['outcome']): Tone => (o === 'chosen' ? 'success' : o === 'nobody-fits' ? 'danger' : 'warning');

export const layerLabel = (l: SkillLayer) => (l === 'core' ? t('core') : l === 'project' ? t('project') : t('order'));
export const layerTone = (l: SkillLayer): Tone => (l === 'core' ? 'primary' : l === 'project' ? 'neutral' : 'success');

/** A history rate as a percentage, or nothing while there are too few samples to say. */
export const ratePercent = (rate?: number) => (rate === undefined ? undefined : `${Math.round(rate * 100)}%`);
