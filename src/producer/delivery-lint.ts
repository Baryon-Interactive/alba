import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { runCheck } from '../check/check.ts';
import { hasDeliveryChecks } from '../check/delivery.ts';
import type { CheckItem } from '../check/general.ts';
import { proposeLintBounce } from './producer.ts';
import { attemptAcceptance, runDeliveredIntakeCheck } from '../review/acceptance.ts';
import { FRESHNESS_REPAIR } from '../verify/verify.ts';

export function lintReworkNote(items: readonly CheckItem[]): string {
  return ['Delivery lint found mechanical problems. Fix each item and deliver again:', FRESHNESS_REPAIR, ...items.filter(i => !i.ok).map((i, n) => `${n + 1}. ${i.name}: ${i.detail}`)].join('\n');
}

/** Called synchronously at all delivery entry points, before returning a reviewable order. */
export function lintDelivery(project: ProjectConfig, orders: Orders, tag: string): void {
  const doc = orders.get(tag), report = doc.reports.at(-1);
  if (report?.status !== 'ready' || orders.stage(doc).stage !== 'awaiting-review') return;
  if (doc.order.kind === 'intake') runDeliveredIntakeCheck(project, orders, tag);
  if (!hasDeliveryChecks(project.checks) && !project.accept && doc.order.kind !== 'intake') return;
  if (!hasDeliveryChecks(project.checks)) { attemptAcceptance(project, orders, tag); return; }
  const events = orders.store.events({ tag: doc.order.tag });
  const prior = [...events].reverse().find(e => e.type === 'check' && e.data?.delivery === true && e.data?.report === report.seq);
  let items = prior?.data?.lint as CheckItem[] | undefined;
  if (!items) {
    try { items = runCheck(project, orders, tag, [], undefined, { delivery: true }).lint ?? []; }
    catch (e) {
      items = [{ name: 'delivery_lint', ok: false, detail: `${(e as Error).message.split('\n')[0]}. Restore the order's worktree/base configuration and rerun checks.` }];
      orders.record(tag, 'check', { delivery: true, report: report.seq, ok: false, lint: items, general: items, base: project.dispatch.base_ref, worktree: doc.order.worktree ?? '' });
    }
  }
  if (items.some(i => !i.ok)) proposeLintBounce(project, orders, tag, report.seq, items, lintReworkNote(items));
  else attemptAcceptance(project, orders, tag);
}

/** Count only uninterrupted lint send-backs; a passing delivery or human rework resets the streak. */
export function lintBounceCount(orders: Orders, tag: string): number {
  const doc = orders.get(tag);
  const lastHuman = Math.max(0, ...doc.actions.filter(a => a.kind === 'rework' && !a.lint).map(a => a.seq));
  const events = orders.store.events({ tag: doc.order.tag }).filter(e => e.type === 'check' && e.data?.delivery === true && Array.isArray(e.data?.lint) && (e.data.lint as CheckItem[]).every(i => i.ok));
  const lastPass = Math.max(0, ...events.map(e => Number(e.data?.report) || 0));
  return doc.actions.filter(a => a.lint && a.kind === 'rework' && a.seq > Math.max(lastHuman, lastPass)).length;
}
