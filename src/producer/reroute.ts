import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { orderPhases } from '../orders/phases.ts';
import { supportsReadOnly } from '../routing/choose.ts';
import { roleForOrder } from '../routing/route.ts';
import { spendToday, ownerOf } from '../usage/spend.ts';
import type { ProducerExecutionEnv } from './producer.ts';

export const ESCALATE_HARD = { id: 'escalate-hard', action: 'reroute' as const, mode: 'propose' as const,
  instruction: 'Consider reroute for diagnosis, structural change, design trade-off or behaviour gate work with repeated non-progress: three consecutive failed/blocked/no-report runs, an open loop finding, the same gate failing in two reports, or at least three reworks. Judge whether a stronger worker can change the approach; choose an exact worker id from producer.escalate_to and write a brief explaining why and what to do differently. An empty list refuses reroute.' };

export function rerouteRefusal(project: ProjectConfig, orders: Orders, doc: OrderDoc, worker: string | undefined, note: string | undefined, env: ProducerExecutionEnv, now = new Date()): string | undefined {
  const refuse = (why: string) => `Reroute refused: ${why}`;
  if (!worker || !note?.trim() || note.length > 2000) return refuse('target, worker and a non-empty note of at most 2000 characters are required.');
  const target = env.workers.workers.find(w => w.id === worker);
  if (!target) return refuse(`unknown worker ${worker}.`);
  if (orderPhases(project, doc)?.current.mode === 'read-only' && !supportsReadOnly(target)) return refuse('worker cannot enforce a read-only phase.');
  if (!target.enabled) return refuse(`worker ${worker} is disabled.`);
  if (!project.producer.escalate_to?.includes(worker)) return refuse('worker is not in producer.escalate_to (the default list is empty).');
  const stage = orders.stage(doc).stage;
  if (['held', 'merged', 'cancelled'].includes(stage)) return refuse(`order is ${stage}.`);
  const current = doc.order.next_worker ?? ownerOf(env.workers.workers, doc.order.worker)?.id ?? doc.runs.at(-1)?.worker;
  if (worker === current) return refuse('same as the current worker.');
  const role = roleForOrder(project, doc, env.workers);
  if (!role.definition) return refuse('order has no role.');
  const missing = (role.definition.requires ?? []).filter(c => !target.capabilities.includes(c));
  if (missing.length) return refuse(`worker lacks role capabilities: ${missing.join(', ')}.`);
  if (target.daily_cap_usd !== undefined && (spendToday(orders.all(), env.workers.workers, env.probes, now).get(worker) ?? 0) >= target.daily_cap_usd) return refuse(`worker ${worker} daily spend cap reached.`);
  const recent = (at: string) => now.getTime() - Date.parse(at) < 86400_000 && Date.parse(at) <= now.getTime();
  if (doc.reroutes?.some(r => r.by === 'producer' && recent(r.at))) return refuse('one reroute per order per 24 hours.');
  if (doc.reroutes?.some(r => r.from === worker && recent(r.at))) return refuse('cannot return to a worker left in the last 24 hours.');
  const day = now.toISOString().slice(0, 10);
  const used = orders.all().flatMap(d => d.reroutes ?? []).filter(r => r.by === 'producer' && r.at.slice(0, 10) === day).length;
  if (used >= (project.producer.budgets.escalations_per_day ?? 4)) return refuse('daily escalation allowance used up.');
}
