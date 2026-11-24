import type { StreamEventName } from '@api';
import { keys, type QueryKey } from './keys.ts';

/**
 * Which queries an event from the stream makes stale. The page never builds its state from event payloads: it only marks the
 * lists it already has as stale and reads them again with the plain calls (docs/console/010-api.md). `run.log` changes nothing here: the
 * log viewer appends those lines itself.
 */
export function invalidationsFor(name: StreamEventName, data: unknown, fallbackProject: string): QueryKey[] {
  const project = (data as { project?: string } | undefined)?.project ?? fallbackProject;
  const tag = (data as { tag?: string } | undefined)?.tag;
  const order = tag
    ? [keys.order(project, tag), keys.diff(project, tag), keys.route(project, tag), keys.orderSkills(project, tag)]
    : [['order', project] as const, ['route', project] as const, ['order-skills', project] as const];
  const overview = [keys.overview(project), keys.projectOverview(project), keys.overviewAll];
  const lists = [...overview, keys.orders(project), keys.projects];
  const detail = tag ? [keys.order(project, tag)] : [['order', project] as const];
  const fields = (data as { data?: { fields?: string[] }; fields?: string[] } | undefined);
  const changed = fields?.data?.fields ?? fields?.fields ?? [];
  switch (name) {
    case 'order.added':
    case 'order.action':
    case 'order.report':
    case 'run.start':
      return [...order, ...lists, ['runs', project] as const];
    case 'order.updated':
      return [...order, ...(changed.some(f => ['stage', 'title', 'worker', 'needs', 'kind'].includes(f)) ? lists : [])];
    case 'run.updated':
    case 'run.activity':
      return [...detail, ['runs', project] as const];
    case 'run.end':
      return [...order, ...lists, keys.workers(project), ['runs', project] as const];
    case 'decision.added':
      return [keys.decisions(project), ...order, ...overview];
    case 'question.asked':
    case 'question.answered':
      return [...order, keys.evidence(project, tag ?? ''), ...lists];
    case 'credits.changed':
      return [keys.credits(project), ...order, ...overview, keys.workers(project)];
    case 'workers.edited':
      return [keys.workers(project), ['route', project] as const, ...overview, keys.skills(project)];
    case 'skills.edited':
      return [keys.skills(project), ['order-skills', project] as const];
    case 'clean.done':
      return [keys.clean(project), keys.cleanEvents(project)];
    case 'check.done':
    case 'refs.adopted':
      return [...order, keys.orders(project)];
    case 'log.other':
      return order;
    case 'quota':
      return [keys.workers(project), keys.quota(project), ...overview, ['route', project] as const];
    case 'tick.done':
      return [...lists, ['machines', project], ['order', project], ['route', project] as const, keys.skills(project), keys.workers(project), keys.session, keys.schedules(project)];
    case 'serve.notice':
    case 'resync':
      return everything;
    case 'run.log':
    case 'run.transcript':
    case 'hello':
      return [];
  }
}

/** After a connection was lost and came back, anything may have changed: everything is read again. */
export const everything: QueryKey[] = [
  keys.overviewAll,
  ['project-overview'],
  ['overview'], ['orders'], ['order'], ['diff'], ['workers'], ['machines'], ['quota'], ['projects'], ['session'],
  ['runs'], ['decisions'], ['evidence'], ['clean'], ['clean-events'], ['credits'], ['lessons'],
  ['route'], ['skills'], ['order-skills'], ['producer'], ['resources'], ['picks'], ['art'], ['spend'], ['usage'], ['readiness'], ['schedules'],
];

export const STREAM_EVENT_NAMES: StreamEventName[] = [
  'hello', 'resync', 'order.added', 'order.updated', 'order.action', 'order.report', 'run.start', 'run.updated', 'run.activity', 'run.end',
  'check.done', 'refs.adopted', 'log.other', 'run.log', 'run.transcript', 'quota', 'tick.done',
  'serve.notice', 'decision.added', 'question.asked', 'question.answered', 'credits.changed', 'clean.done', 'workers.edited', 'skills.edited',
];
