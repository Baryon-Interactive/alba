import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { readOrderFileWithHash } from '../orders/preflight.ts';
import type { Orders } from '../orders/service.ts';
import { approve, rework } from '../run/review.ts';

/** The decisions a person can make about an order. The command line and the web board both go through `humanAction`. */
export const HUMAN_ACTIONS = ['queue', 'cancel', 'hold', 'stop', 'release', 'approve', 'rework', 'review-manual', 'review-auto', 'check-independent', 'check-none'] as const;
export type HumanAction = (typeof HUMAN_ACTIONS)[number];

export function isHumanAction(value: string): value is HumanAction {
  return (HUMAN_ACTIONS as readonly string[]).includes(value);
}

/** Does this action need a typed note before it makes sense? */
export const NOTE_REQUIRED: readonly HumanAction[] = ['rework'];

/**
 * Applies one action. `approve` is the full review step (the branch must already be merged, the accept command
 * must pass, the accept file is written); `rework` needs a note; the rest are plain actions on the order.
 * Every change is logged as an event by the `Orders` instance's actor.
 */
/**
 * Stops the open run of an order: its recorded process and every process under it (the capture wrapper, the worker CLI and what that
 * started) are ended after their identity is checked, the run is closed as cancelled, and the order is held, so that no tick starts it
 * again. Start it again with `alba run <TAG> --worker <id>` (or Run in the console), or release it.
 */
export function stopRun(orders: Orders, tag: string, note?: string): string | undefined {
  const doc = orders.get(tag);
  if (!doc.runs.some(r => r.ended === undefined)) fail('{tag} has no open run to stop. To keep it from starting, hold it: alba orders act {tag} hold', { tag: doc.order.tag });
  let warning: string | undefined;
  orders.act(tag, 'hold', { note: note?.trim() || t('run stopped by a person'), onStopWarning: message => { warning = message; } });
  return warning;
}

export function humanAction(project: ProjectConfig, orders: Orders, tag: string, action: HumanAction, note?: string, branch?: string, override = false): string {
  if (branch && action !== 'approve') fail('--branch only goes with approve (to record a branch on its own: alba orders set <TAG> --branch b).');
  switch (action) {
    case 'check-independent': case 'check-none': orders.update(tag, { check: action === 'check-independent' ? 'independent' : 'none' }); break;
    case 'review-manual': case 'review-auto': orders.update(tag, { review: action === 'review-manual' ? 'manual' : 'auto' }); break;
    case 'approve': approve(project, orders, tag, note, branch, override); break;
    case 'rework': rework(orders, tag, note, { max: project.dispatch.max_reworks, override }); break;
    case 'queue': {
      if (override) {
        const doc = orders.get(tag);
        const trimmed = note?.trim() ?? '';
        if (trimmed.length < 10) fail('An override needs a note of at least 10 characters.');
        const stage = orders.stage(doc).stage;
        if (stage !== 'queued' && stage !== 'waiting-needs') orders.act(tag, 'queue', { note });
        const { hash } = readOrderFileWithHash(project, doc.order.tag);
        orders.record(doc.order.tag, 'preflight-overridden', { hash, note: trimmed });
        break;
      }
      orders.act(tag, 'queue', { note });
      break;
    }
    case 'cancel': case 'hold': case 'release': orders.act(tag, action, { note }); break;
    case 'stop': stopRun(orders, tag, note); break;
    default: fail('Unknown action "{action}".', { action: String(action) });
  }
  return orders.stage(orders.get(tag)).stage;
}
