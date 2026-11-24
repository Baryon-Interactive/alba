import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { foundationNotice } from '../foundations/foundations.ts';
import type { Mandate, OrderDoc } from '../orders/model.ts';
import { nextFreeTag, type Orders } from '../orders/service.ts';
import { fillOrderBody } from '../orders/templates.ts';
import { findOrderFile } from '../run/prompt.ts';
import { classifyByRules, orderText } from '../routing/classify.ts';
import { writeBack } from '../table/write.ts';

export interface NewOrderInput {
  phases?: 'none';
  check?: 'independent' | 'none';
  review?: 'manual' | 'auto';
  role?: string;
  tag: string;
  title: string;
  kind?: string;
  needs?: string[];
  worker?: string;
  /** The model the order runs with on its own worker (see `Order.model`). */
  model?: string;
  heavy?: string;
  mandate?: Mandate;
  branch?: string;
  base_ref?: string;
  sparse?: string[];
  tags?: string[];
  /** Skills (names from the registry) the order always gets. */
  skills?: string[];
  worktree?: string;
  /** Resources (names under `resources` in the project file) a run of the order holds a lease on. */
  uses?: string[];
  /** Tool plugins (enabled under `plugins` in the project file) a run of the order gets. */
  tools?: string[];
  /** Markdown text of the work order; written to `<work_orders>/<TAG>-<slug>.md`. */
  body?: string;
  slug?: string;
  queue?: boolean;
}

export interface NewOrderOutcome {
  doc: OrderDoc;
  /** The work-order file that was written. */
  file?: string;
  /** A row was added to the project's dispatch table. */
  tableRow: boolean;
  /** Why the table row was not added although the project asks for it (the order and the file exist anyway). */
  tableWarning?: string;
  /** The project's foundations (`foundations:`) apply to the order and are not ready: what is missing, and whether it may start. */
  foundationWarning?: string;
}

/** A readable part of a file name from a title: lower-case ASCII words joined by "-". */
export function slugOf(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'order';
}

/**
 * Makes an order, the same way for the command line and the board:
 *  1. refuse before anything is created: a tag in use, or a work-order file that exists (an existing file is never replaced);
 *  2. write the file, when a body was given;
 *  3. add the order to the state, and queue it when asked;
 *  4. when the project has `dispatch_table.write_back`, add its row to the table (a backup is made first).
 */
export function createOrder(project: ProjectConfig, orders: Orders, input: NewOrderInput, now: Date = new Date()): NewOrderOutcome {
  const taken = orders.resolveTag(input.tag);
  if (taken) fail('Order "{tag}" already exists ({stage}; a merged or cancelled order keeps its tag). The next free tag like it is {next}.', { tag: taken, stage: orders.stage(orders.get(taken)).stage, next: nextFreeTag(input.tag, orders.all().map(d => d.order.tag)) });
  if (input.base_ref !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(input.base_ref)) fail('"{ref}" is not a branch name (letters, digits, ".", "_", "-" and "/", not starting with "-").', { ref: input.base_ref });
  let file: string | undefined;
  let bodyToWrite: string | undefined;
  let filledSections: string[] = [];
  const templateKind = input.kind?.trim() || 'default';
  // A queued order is started by the next pass, and a run needs the order's text: refuse now rather than fail at the start.
  if (input.queue && input.body === undefined) {
    let present = false;
    try { findOrderFile(project.work_orders, input.tag); present = true; } catch { /* none */ }
    if (!present) fail('{tag} has no work-order file in {dir}: give its text (--body-file) or write {tag}-<name>.md there, then queue it.', { tag: input.tag, dir: project.work_orders });
  }
  if (input.body !== undefined) {
    if (!input.body.trim()) fail('The work-order text is empty.');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.tag)) fail('Invalid order tag "{tag}": use letters, digits, "-" and "_", starting with a letter.', { tag: input.tag });
    if (input.slug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(input.slug)) fail('The file name part "{slug}" may only use letters, digits, "-" and "_".', { slug: input.slug });
    let existing: string | undefined;
    try { existing = findOrderFile(project.work_orders, input.tag); } catch { /* none yet */ }
    if (existing) fail('A work-order file for {tag} exists already: {file}. Nothing was created.', { tag: input.tag, file: existing });
    file = path.join(project.work_orders, `${input.tag}-${input.slug ?? slugOf(input.title)}.md`).replace(/\\/g, '/');
    if (existsSync(file)) fail('{file} exists already. Nothing was created.', { file });
    const filled = fillOrderBody(project, templateKind, input.tag, input.body);
    bodyToWrite = filled.body;
    filledSections = filled.filled;
  }
  if (file && bodyToWrite !== undefined) {
    mkdirSync(project.work_orders, { recursive: true });
    const fd = openSync(file, 'wx');     // fails if the file appeared since the check above
    try { writeSync(fd, bodyToWrite.endsWith(String.fromCharCode(10)) ? bodyToWrite : bodyToWrite + String.fromCharCode(10)); } finally { closeSync(fd); }
  }
  let doc: OrderDoc;
  try {
    // what the order is, from the project's rules (a classifier worker is asked later, never here); kept on the order
    const at = now.toISOString();
    const draft: OrderDoc = { version: 1, order: { tag: input.tag, title: input.title.trim(), kind: input.kind?.trim() || 'task', needs: [], ...(input.tags?.length ? { tags: input.tags.map(x => x.trim().toLowerCase()) } : {}), created: at, updated: at }, runs: [], reports: [], actions: [] };
    const routing = project.kinds?.length ? classifyByRules(project, draft, orderText(project, input.tag), at) : undefined;
    doc = orders.add({ phases: input.phases, check: input.check, review: input.review, role: input.role, ...(routing ? { routing } : {}), tag: input.tag, title: input.title, kind: input.kind?.trim() || 'task', needs: input.needs, worker: input.worker, model: input.model, heavy: input.heavy, mandate: input.mandate, tags: input.tags, skills: input.skills, uses: input.uses, tools: input.tools, branch: input.branch, base_ref: input.base_ref, worktree: input.worktree, ...(input.sparse !== undefined ? { sparse: input.sparse } : {}) });
    if (filledSections.length) orders.record(doc.order.tag, 'order-template-filled', { kind: templateKind, sections: filledSections });
  } catch (e) {
    if (file) rmSync(file, { force: true });     // the order was refused (no title, a need on itself): leave no file behind
    throw e;
  }
  if (input.queue) doc = orders.act(input.tag, 'queue');
  const foundationWarning = foundationNotice(project, doc);
  const outcome: NewOrderOutcome = { doc, ...(file ? { file } : {}), tableRow: false, ...(foundationWarning ? { foundationWarning } : {}) };
  const table = project.dispatch_table;
  if (table?.write_back) {
    try {
      const done = writeBack(orders, table, table.file, project.state_dir, now);
      outcome.tableRow = done.added.some(tag => tag.toLowerCase() === input.tag.toLowerCase());
      if (!outcome.tableRow) outcome.tableWarning = t('The table has no status word for the stage "{stage}", so no row was added.', { stage: orders.stage(orders.get(input.tag)).stage });
    } catch (e) {
      outcome.tableWarning = (e as Error).message.split('\n')[0];
    }
  }
  return outcome;
}
