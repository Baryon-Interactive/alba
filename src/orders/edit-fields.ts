import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import { findOrderFile } from '../run/prompt.ts';
import { enabledTools } from '../cli/plugins.ts';
import type { WorkersFile } from '../workers/config.ts';
import type { Order, OrderDoc } from './model.ts';
import type { Orders } from './service.ts';

/** The fields of an order a person may change from the console after it is made (the git place has its own command). */
export interface OrderFields {
  title?: string; kind?: string; priority?: number | null; worker?: string | null; model?: string | null; role?: string; needs?: string[]; tags?: string[]; skills?: string[];
  uses?: string[]; tools?: string[]; sparse?: string[] | null; heavy?: string | null; condition?: string | null; check?: 'independent' | 'none'; review?: 'manual' | 'auto'; intent?: string;
}

/**
 * Changes fields of an order with the same checks as `alba orders set` and `alba orders add`: a pinned worker must exist, a
 * route must resolve, resources must be declared, tools enabled, and needs must name orders. `null` clears a field. One event
 * per field (`order-updated`, from `Orders.update`), and `worker-set` when the pinned worker changes.
 */
export function editOrderFields(project: ProjectConfig, orders: Orders, workers: WorkersFile | undefined, tag: string, fields: OrderFields): OrderDoc {
  const before = orders.get(tag).order;
  const patch: Partial<Order> = {};
  if (fields.title !== undefined) { if (!fields.title.trim()) fail('The title cannot be empty.'); patch.title = fields.title.trim(); }
  if (fields.kind !== undefined) { if (!fields.kind.trim()) fail('The kind cannot be empty.'); patch.kind = fields.kind.trim(); }
  if (fields.intent !== undefined) patch.intent = fields.intent;
  if (fields.priority !== undefined) patch.priority = fields.priority === null ? undefined : fields.priority;
  if (fields.worker !== undefined) {
    if (fields.worker !== null && fields.worker !== '') {
      const known = workers?.workers ?? [];
      if (!known.some(w => w.id === fields.worker)) fail('Unknown worker "{id}". Known: {known}.', { id: fields.worker, known: known.map(w => w.id).join(', ') });
      patch.worker = fields.worker;
    } else patch.worker = undefined;
  }
  if (fields.model !== undefined) patch.model = fields.model?.trim() || undefined;
  if (fields.role !== undefined) {
    if (fields.role) resolveRole(effectiveRoles(project, workers), { role: fields.role, kind: fields.kind ?? before.kind });
    patch.role = fields.role;
  }
  if (fields.needs !== undefined) {
    const missing = fields.needs.filter(n => !orders.all().some(d => d.order.tag.toLowerCase() === n.toLowerCase()));
    if (missing.length) fail('No order {tags}.', { tags: missing.join(', ') });
    patch.needs = fields.needs;
  }
  if (fields.tags !== undefined) patch.tags = fields.tags;
  if (fields.skills !== undefined) patch.skills = fields.skills;
  if (fields.uses !== undefined) {
    const unknown = fields.uses.filter(n => !(project.resources && n in project.resources));
    if (unknown.length) fail('The project does not declare the resource(s): {names}. Declared: {known}.', { names: unknown.join(', '), known: Object.keys(project.resources ?? {}).join(', ') || '-' });
    patch.uses = fields.uses;
  }
  if (fields.tools !== undefined) patch.tools = fields.tools.length ? enabledTools(project, fields.tools.join(',')) : [];
  if (fields.sparse !== undefined) patch.sparse = fields.sparse === null ? undefined : fields.sparse;
  if (fields.heavy !== undefined) patch.heavy = fields.heavy || undefined;
  if (fields.condition !== undefined) patch.condition = fields.condition || undefined;
  if (fields.check !== undefined) patch.check = fields.check;
  if (fields.review !== undefined) patch.review = fields.review;
  const doc = orders.update(tag, patch as Parameters<Orders['update']>[1]);
  if (fields.worker !== undefined && (before.worker ?? null) !== (doc.order.worker ?? null)) orders.record(before.tag, 'worker-set', { from: before.worker ?? null, to: doc.order.worker ?? null, why: 'console' });
  return doc;
}

/**
 * Replaces the text of an order's work-order file. `expected`: the text the person started from; when the file changed since
 * (a producer or another person wrote it), nothing is written and the edit is refused, so no one's change is lost.
 */
export function editOrderBody(project: ProjectConfig, orders: Orders, tag: string, text: string, expected?: string): string {
  const doc = orders.get(tag);
  const file = findOrderFile(project.work_orders, doc.order.tag);
  const now = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (expected !== undefined && now.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) fail('{file} changed since you opened it; reload and edit again.', { file });
  if (!text.trim()) fail('The work order cannot be empty.');
  const out = /\r\n/.test(now) ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
  if (out === now) return file;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, file);
  orders.record(doc.order.tag, 'order-body-edited', { file, chars: out.length });
  return file;
}

export const ORDER_FIELD_NAMES = ['title', 'kind', 'priority', 'worker', 'model', 'role', 'needs', 'tags', 'skills', 'uses', 'tools', 'sparse', 'heavy', 'condition', 'check', 'review', 'intent'] as const;
export const describeFields = () => t('Fields: {names}.', { names: ORDER_FIELD_NAMES.join(', ') });
