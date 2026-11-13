import type { ProducerLogRow, ProducerWorkspace } from '@api';
export { activityLine, activityVerb } from '../../../src/producer/activity-format.ts';

/** Use the browser's calendar, not a UTC date substring (DST-safe and testable). */
export function activityDay(at: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function groupActivity(rows: ProducerLogRow[], timeZone?: string): { day: string; at: string; rows: ProducerLogRow[] }[] {
  const groups = new Map<string, { day: string; at: string; rows: ProducerLogRow[] }>();
  for (const row of rows) {
    const day = activityDay(row.at, timeZone);
    if (!groups.has(day)) groups.set(day, { day, at: row.at, rows: [] });
    groups.get(day)!.rows.push(row);
  }
  return [...groups.values()];
}
export function needsProducerDecision(workspace?: Pick<ProducerWorkspace, 'actions' | 'questions' | 'directionProposals'>): boolean {
  return !!workspace && (!!workspace.questions?.length || workspace.directionProposals?.some(p => p.status === 'proposed') || workspace.actions?.some(a => a.status === 'proposed' || a.status === 'would-do' && !!a.messageId));
}
export function activityRows(rows: ProducerLogRow[], filters: { kind: string; order: string; status: string; autonomous: boolean; superseded: boolean }): ProducerLogRow[] {
  const matches = (r: ProducerLogRow) => (!filters.kind || r.kind === filters.kind) && (!filters.order || r.order === filters.order) && (!filters.status || r.status === filters.status) && (!filters.autonomous || r.autonomous) && (filters.superseded || filters.status === 'superseded' || r.status !== 'superseded');
  return rows.filter(r => matches(r) || r.children?.some(matches));
}
