import type { AttentionGroup, AttentionItem, OverviewAll, Stage } from '@api';
import { t } from '@/i18n';

export const OVERVIEW_CAPS = { live: 8, projects: 6, workers: 4, merges: 8, resources: 3, moves: 3, held: 3, attention: 8 };
export const projectPath = (id: string) => `/p/${encodeURIComponent(id)}`;
export const orderPath = (p: string, tag: string) => `${projectPath(p)}/orders/${encodeURIComponent(tag)}`;
export const attentionPath = (item: AttentionItem) => item.tag ? orderPath(item.project, item.tag) : item.target ? `${projectPath(item.project)}/${item.target}` : projectPath(item.project);
export const attentionProjects = (group: AttentionGroup) => [...new Set(group.items.flatMap(i => i.projects ?? [i.project]))];
export const attentionLabel = (kind: string): string => ({
  answer: t('Waiting for your answer'), card: t('Waiting for your click'), review: t('Waiting for your review'),
  picks: t('Waiting for a pick'), quotes: t('Quotes waiting for approval'), blocked: t('Blocked, failed or dropped'),
  stalled: t('Stalled runs'), 'start-failed': t('Failed starts'), looping: t('Looping runs'), 'lease-expired': t('Expired leases'),
  quota: t('Quota problems'), 'no-fit': t('No worker fits'), 'no-worker': t('No available worker'), spend: t('Spend limits'),
  'usage-waste': t('Usage warnings'), 'usage-budget': t('Usage budgets'),
  'commit-nudge': t('Commit reminders'), lingering: t('Delivered runs still open'), 'maybe-finished': t('Runs to record'),
  'no-report': t('Missing reports'), launch: t('Launch problems'), monitor: t('Monitor problems'), config: t('Configuration problems'),
}[kind] ?? t('Problems'));

export const STAGE_COLORS: Record<Stage, string> = {
  merged: '#22a58c', 'awaiting-review': '#9b85f8', running: '#549cf4', monitoring: '#60c1db', queued: '#f5bb57',
  'waiting-needs': '#cf8c5e', held: '#a3a1af', planned: '#636674', draft: '#636674', 'awaiting-user': '#e9a33a', blocked: '#ed6b73',
  failed: '#c34d61', dropped: '#b57998', idle: '#868a97', cancelled: '#454854',
};
export const STAGE_ORDER: Stage[] = ['merged', 'awaiting-review', 'running', 'monitoring', 'queued', 'waiting-needs', 'awaiting-user', 'blocked', 'failed', 'dropped', 'held', 'planned', 'draft', 'idle', 'cancelled'];
export const mergeTotal = (o: OverviewAll) => o.days.reduce((n, d) => n + Object.values(d.merges).reduce((a, b) => a + b, 0), 0);
