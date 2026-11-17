import { fail } from '../i18n.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { draftingTemplateFor, fillOrderBody } from '../orders/templates.ts';
import type { WorkerState } from '../tick/plan.ts';
import { classifyByRules, orderText } from '../routing/classify.ts';
import type { WorkersFile } from '../workers/config.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import { rolePolicy, chooseWorker } from '../routing/choose.ts';
import { baseRefOf } from '../run/worktree.ts';
import { findOrderFile } from '../run/prompt.ts';
import { resourceMatches, kindOfOrder } from '../resources/leases.ts';
import { slugOf } from '../service/new-order.ts';
import { standingDirection } from './conversation-state.ts';
import { capacityUsage } from '../tick/capacity.ts';

/** An order body has an Acceptance section: `## Acceptance`, also numbered (`## 4. Acceptance criteria`) as many project templates write it. */
export const hasAcceptanceSection = (body: string): boolean => /^#{1,6}\s+(?:\d+[.)]?\s*)?Acceptance\b/im.test(body);
export interface DraftOrder { tag: string; title: string; kind: string; needs: string[]; body: string; worker?: string }

export function planFingerprint(doc: OrderDoc): string {
  const { title, kind, needs, intent, role } = doc.order;
  return createHash('sha256').update(JSON.stringify({ title, kind, needs, intent, role })).digest('hex');
}

export function readyToDraft(project: ProjectConfig, orders: Orders, workers?: readonly WorkerState[], workersFile?: WorkersFile): OrderDoc[] {
  const docs = orders.all(), merged = orders.mergedSet(docs);
  return docs.filter(doc => {
    if (orders.stage(doc, merged).stage !== 'planned' || doc.order.needs.some(n => !merged.has(n))) return false;
    if (project.drafting?.when !== 'free-slot') return true;
    const kind = doc.order.kind;
    const usage = capacityUsage(docs.map(d => ({ stage: orders.stage(d, merged).stage, kind: kindOfOrder(project, d), heavy: d.order.heavy })), project.dispatch.caps)[kind];
    if (usage && usage.used >= usage.cap) return false;
    return !!workers && !!chooseWorker({ kind, tags: [], workerText: doc.order.worker, role: rolePolicy(resolveRole(effectiveRoles(project, workersFile), doc.order)) }, workers).chosen;
  });
}

/** Complete, durable drafting input, shared by card delivery and producer_read. */
export function draftingContext(project: ProjectConfig, orders: Orders, tag: string) {
  const doc = orders.get(tag);
  const template = project.drafting?.template ? readFileSync(project.drafting.template, 'utf8') : draftingTemplateFor(project, doc.order.kind || 'default', doc.order.tag);
  const examples = orders.all().filter(d => d.order.kind === doc.order.kind && orders.stage(d).stage === 'merged')
    .sort((a, b) => (b.actions.filter(a => a.kind === 'approve').at(-1)?.at ?? '').localeCompare(a.actions.filter(a => a.kind === 'approve').at(-1)?.at ?? ''))
    .slice(0, project.drafting?.examples ?? 3).map(d => ({ tag: d.order.tag, body: orderText(project, d.order.tag) }));
  return { order: doc.order, template, direction: standingDirection(project), needs: doc.order.needs.map(n => {
    const needed = orders.get(n);
    const acceptFile = path.join(project.work_orders, `${needed.order.tag}.accept.md`);
    return { order: needed.order, reports: needed.reports, acceptance: needed.actions.filter(a => ['approve', 'rework'].includes(a.kind)), acceptanceNotes: existsSync(acceptFile) ? readFileSync(acceptFile, 'utf8') : '', events: orders.store.events({ tag: n }).filter(e => /accept|approve|check|verif/.test(e.type)) };
  }), examples };
}

/** Repository-relative paths in backticks, Markdown links or plain prose; globs are not concrete paths. */
export function namedPaths(body: string): string[] {
  const text = body.replace(/https?:\/\/[^\s<>`)]+/g, '');
  const tokens = text.match(/[^\s`<>"'()[\],;]+/g) ?? [];
  return [...new Set(tokens.map(p => p.replace(/[.:!?]+$/, '').replace(/\\/g, '/')).filter(p => !/[{}*?]/.test(p) && (/^(?:[A-Za-z]:)?[\w@./-]+\/[\w@./-]+$/.test(p) || /^[\w.-]+\.(?:md|tsx?|json|ya?ml|cs|py|html|css|txt)$/.test(p))))];
}

export function draftPreview(project: ProjectConfig, orders: Orders, draft: DraftOrder, workers: readonly WorkerState[] = [], workersFile?: WorkersFile) {
  const doc = orders.get(draft.tag);
  // As accepting it does: the draft's worker hint only fills an order without a worker or pin.
  const worker = doc.order.worker ?? (doc.order.next_worker ? undefined : draft.worker);
  const proposed = { ...doc, order: { ...doc.order, title: draft.title, kind: draft.kind, worker, needs: draft.needs } };
  const classifier = classifyByRules(project, { ...proposed, order: { ...proposed.order, kind: 'task' } }, draft.body.slice(0, project.classifier?.max_chars ?? 4000), new Date().toISOString());
  const routing = classifyByRules(project, proposed, draft.body.slice(0, project.classifier?.max_chars ?? 4000), new Date().toISOString());
  const route = chooseWorker({ kind: routing.kind || draft.kind, tags: routing.tags, workerText: doc.order.next_worker ?? worker, role: rolePolicy(resolveRole(effectiveRoles(project, workersFile), { ...proposed.order, kind: routing.kind || draft.kind })) }, workers);
  const missingPaths = namedPaths(draft.body).filter(file => {
    if (path.isAbsolute(file) || file.startsWith('../') || /^[A-Za-z]:/.test(file)) return true;
    try { execFileSync('git', ['cat-file', '-e', `${baseRefOf(project)}:${file.replace(/^\.\//, '')}`], { cwd: project.root, stdio: 'ignore', windowsHide: true }); return false; } catch { return true; }
  });
  return { body: draft.body, classifier, routing, route, resources: resourceMatches(project, proposed.order, draft.body), missingPaths, baseRef: baseRefOf(project) };
}

export function acceptDraft(project: ProjectConfig, orders: Orders, draft: DraftOrder, fingerprint: string): string {
  return orders.store.transaction(() => {
    const doc = orders.get(draft.tag);
    const templateKind = doc.order.kind || 'default';
    const filled = fillOrderBody(project, templateKind, doc.order.tag, draft.body);
    const body = filled.body;
    if (!doc.order.planned && orders.stage(doc).stage === 'queued') {
      const file = findOrderFile(project.work_orders, draft.tag);
      if (readFileSync(file, 'utf8').trimEnd() === body.trimEnd()) return file;
    }
    if (orders.stage(doc).stage !== 'planned' || planFingerprint(doc) !== fingerprint) fail('The planned order changed; draft it again.');
    if (!body.trim() || !hasAcceptanceSection(body)) fail('A draft needs a body with an Acceptance section.');
    if (draft.title !== doc.order.title || draft.kind !== doc.order.kind || JSON.stringify(draft.needs) !== JSON.stringify(doc.order.needs)) fail('A draft must preserve the planned title, kind and needs.');
    const merged = orders.mergedSet(orders.all());
    if (draft.needs.some(n => !merged.has(n))) fail('All needs must be merged before accepting a draft.');
    let existing: string | undefined;
    try { existing = findOrderFile(project.work_orders, draft.tag); } catch { /* no body yet */ }
    const file = path.join(project.work_orders, `${draft.tag}-${slugOf(doc.order.title)}.md`);
    if (existing && (path.resolve(existing) !== path.resolve(file) || readFileSync(existing, 'utf8').trimEnd() !== body.trimEnd())) fail('A different work-order file already exists.');
    mkdirSync(project.work_orders, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, body.trimEnd() + '\n', { flag: 'wx', encoding: 'utf8' });
    // The draft's worker is only a hint: it fills an empty worker, and never replaces or clears a person's worker or a producer pin
    // (`update` clears `next_worker` whenever `worker` is in the patch).
    const hint = draft.worker?.trim() && !doc.order.worker && !doc.order.next_worker ? { worker: draft.worker.trim() } : {};
    orders.update(draft.tag, { planned: false, ...hint, routing: classifyByRules(project, doc, body, orders.now()) });
    if (filled.filled.length) orders.record(doc.order.tag, 'order-template-filled', { kind: templateKind, sections: filled.filled });
    orders.act(draft.tag, 'queue');
    orders.record(draft.tag, 'draft-accepted', { file, fingerprint });
    return file;
  });
}
