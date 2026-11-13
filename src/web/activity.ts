import { statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Probes } from '../tick/gather.ts';
import type { StreamEvents } from '../api/types.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { pickupOutbox } from '../run/messages.ts';
import { liveRuns } from '../run/live.ts';

/** Incremental live-log parsing and mailbox writes run outside the HTTP loop in production. */
export function activityScanner(probes: Probes) {
  const liveMarks = new Map<string, number>();
  const liveValues = new Map<string, string>();
  const liveProbes = { ...probes };
  return (projects: ProjectConfig[]) => {
    const events: StreamEvents['run.activity'][] = [];
    const now = Date.now();
    for (const project of projects) {
      const orders = new Orders(stateStore(project), undefined, 'serve');
      for (const doc of orders.all()) for (const run of doc.runs.filter(r => !r.ended)) {
        const key = `${project.id}:${doc.order.tag}:${run.id}`;
        if (now - (liveMarks.get(key) ?? 0) < 1000) continue;
        liveMarks.set(key, now);
        pickupOutbox(orders, doc.order.tag);
        const live = liveRuns.read(project, doc.order.tag, run, liveProbes, doc.order.worktree, true);
        let ack = '';
        if (doc.order.worktree) try { const stat = statSync(path.join(doc.order.worktree, '.alba', 'inbox-ack')); ack = `${stat.size}:${stat.mtimeMs}`; } catch { /* no acknowledgements yet */ }
        const signature = JSON.stringify({ ...live, current: live.current && { ...live.current, elapsed_seconds: 0 }, long_command_seconds: 0, ack });
        if ((run.events_file || run.log) && liveValues.get(key) !== signature) {
          liveValues.set(key, signature);
          events.push({ project: project.id, tag: doc.order.tag, key: `${doc.order.tag}:${run.id}`, live });
        }
      }
    }
    return events;
  };
}
