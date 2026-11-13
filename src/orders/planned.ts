import { fail } from '../i18n.ts';
import type { ProjectConfig } from '../config.ts';
import { nextFreeTag, type Orders } from './service.ts';
import { findOrderFile } from '../run/prompt.ts';

export interface PlanInput { tag: string; title: string; kind: string; needs: string[]; intent: string; role?: string }

export function planOrder(project: ProjectConfig, orders: Orders, input: PlanInput) {
  if (!input.kind?.trim() || !input.intent?.trim()) fail('A planned order requires kind and intent.');
  let file: string | undefined;
  try { file = findOrderFile(project.work_orders, input.tag); } catch { /* no body yet */ }
  if (file) fail('A planned order cannot already have a work-order file.');
  // An existing order that was only listed (stage draft: no body, never queued or run) becomes a plan in place,
  // so the producer can draft it. Anything further along keeps the duplicate-tag refusal of add().
  const existing = orders.resolveTag(input.tag);
  if (existing) {
    const doc = orders.get(existing);
    if (orders.stage(doc).stage !== 'draft' || doc.runs.length) fail('Order "{tag}" already exists and is past the draft stage; only a listed order without a body can become a plan. The next free tag like it is {next}.', { tag: existing, next: nextFreeTag(input.tag, orders.all().map(d => d.order.tag)) });
    orders.update(existing, { title: input.title.trim() || doc.order.title, kind: input.kind.trim(), needs: input.needs.length ? input.needs : doc.order.needs, intent: input.intent.trim(), ...(input.role ? { role: input.role } : {}), planned: true });
    orders.record(existing, 'planned-from-draft', { intent: input.intent.trim() });
    return orders.get(existing);
  }
  return orders.add({ ...input, intent: input.intent.trim(), planned: true });
}

export function editPlan(orders: Orders, tag: string, patch: Partial<Omit<PlanInput, 'tag'>>) {
  if (orders.stage(orders.get(tag)).stage !== 'planned') fail('Only a planned order can be edited as a plan.');
  for (const key of ['title', 'kind', 'intent'] as const) if (patch[key] !== undefined && !patch[key]!.trim()) fail(`${key} cannot be empty.`);
  return orders.update(tag, patch);
}
