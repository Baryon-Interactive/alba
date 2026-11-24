import type { ProjectConfig } from '../config.ts';
import { routingOf } from '../routing/classify.ts';
import { isGenericKind } from '../routing/kinds.ts';
import type { OrderDoc } from './model.ts';
import type { Phase } from './phase-config.ts';

/** Replay cycle boundaries. Reworking a later phase retains earlier plans. */
export function orderPhases(project: ProjectConfig, doc: OrderDoc, kind = doc.order.kind) {
  if (!project.phases || doc.order.phases === 'none') return;
  if (isGenericKind(kind)) kind = routingOf(project, doc).kind || kind;
  const list = project.phases[kind];
  if (!Array.isArray(list) || !list.length) return;
  const reset = doc.actions.filter(a => a.kind === 'rework' || (a.kind === 'queue' && !doc.reroutes?.some(r => r.seq === a.seq)));
  const startIndex = (a: typeof reset[number]) => a.kind === 'queue' ? 0 : a.phase ? list.findIndex(p => p.id === a.phase) : list.length - 1;
  const last = reset.at(-1);
  let index = Math.max(0, last ? startIndex(last) : 0);
  const run = doc.runs.findLast(r => r.seq > (last?.seq ?? 0) && r.phase);
  if (run) {
    const recorded = list.findIndex(p => p.id === run.phase);
    if (recorded >= 0) {
      index = recorded;
      if ((!run.split_kinds || doc.actions.some(a => a.kind === 'accept-split')) && run.ended && run.outcome === 'completed' && run.next_phase && doc.reports.findLast(r => r.run === run.id)?.status === 'ready') {
        const next = list.findIndex(p => p.id === run.next_phase);
        index = next >= 0 ? next : Math.min(index + 1, list.length - 1);
      }
    }
  }
  const runsOf = (phase: Phase) => {
    const i = list.indexOf(phase);
    const cutoff = reset.findLast(a => startIndex(a) <= i)?.seq ?? 0;
    return doc.runs.filter(r => r.phase === phase.id && r.seq > cutoff);
  };
  const planOf = (phase: Phase) => {
    const source = runsOf(phase).findLast(r => r.outcome === 'completed');
    const report = source && doc.reports.findLast(r => r.run === source.id);
    return source && report?.status === 'ready' && report.plan ? { run: source, text: report.plan } : undefined;
  };
  const previousPlan = () => list.slice(0, index).map(planOf).findLast(plan => plan !== undefined);
  return { list, index, current: list[index]!, planOf, runsOf, previousPlan };
}
