import { textConventions } from '../i18n.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { DecisionsConfig, ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { findTables, pickTable } from '../table/markdown.ts';
import { readStateFile, appendStateFile, stateTransaction } from '../orders/state-files.ts';

/** What is written as the source of a decision that was taken by default, without the user's words. */
export const DEFAULT_SOURCE = 'default (the user gave no instruction)';

const idOf = (cfg: DecisionsConfig, n: number) => `${cfg.id_prefix}${n}`;

/** `D2031`, `d2031` or `2031` as a number. */
export function parseDecisionId(cfg: DecisionsConfig, text: string): number | undefined {
  const m = new RegExp(`^${cfg.id_prefix}?\\s*(\\d+)$`, 'i').exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

interface Stored { id: string; number: number; date: string; text: string; source: string; sourceKind: 'quote' | 'default'; by: string; at: string }

function readStored(cfg: DecisionsConfig): A.DecisionEntry[] {
  const rel = cfg.stateProject ? path.relative(cfg.stateProject.state_dir, cfg.store) : undefined;
  const text = cfg.stateProject && rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? readStateFile(cfg.stateProject, rel) : existsSync(cfg.store) ? readFileSync(cfg.store, 'utf8') : undefined;
  if (!text) return [];
  const out: A.DecisionEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line) as Stored; out.push({ id: idOf(cfg, s.number), ...(s.id !== idOf(cfg, s.number) ? { displayId: s.id } : {}), number: s.number, date: s.date, text: s.text, source: s.source, sourceKind: s.sourceKind, by: s.by, at: s.at }); } catch { /* a half-written last line is skipped */ }
  }
  return out;
}

interface TableRead { entries: A.DecisionEntry[]; duplicates: { id: string; topics: string[] }[] }

/** The parsed table(s) of a file, kept until the file changes (a big decisions file is not read again for every request). */
const tableCache = new Map<string, { sig: string; read: TableRead }>();

function rowsToEntries(cfg: DecisionsConfig, rows: readonly string[][], topic: string | undefined): A.DecisionEntry[] {
  const out: A.DecisionEntry[] = [];
  for (const cells of rows) {
    const number = parseDecisionId(cfg, cells[cfg.id_column - 1] ?? '');
    if (number === undefined) continue;
    const date = cfg.date_column ? cells[cfg.date_column - 1] ?? '' : '';
    out.push({ id: idOf(cfg, number), ...(cells[cfg.id_column - 1].trim() !== idOf(cfg, number) ? { displayId: cells[cfg.id_column - 1].trim() } : {}), number, date: /\d{4}-\d{2}-\d{2}/.exec(date)?.[0] ?? date, text: cells[cfg.text_column - 1] ?? '', source: cfg.source_column ? cells[cfg.source_column - 1] ?? '' : '', sourceKind: 'imported', ...(topic ? { topic } : {}) });
  }
  return out;
}

/**
 * The decisions of the project's Markdown file (read only): the first table, the first table under a heading (`section`), or
 * every table whose rows hold decision numbers (`all_tables`; each entry gets the heading of its section as `topic`). A number found
 * twice keeps the later entry; the places are listed in `duplicates`.
 */
function readTable(cfg: DecisionsConfig): TableRead {
  if (!cfg.file || !existsSync(cfg.file)) return { entries: [], duplicates: [] };
  let sig = '';
  try { const st = statSync(cfg.file); sig = `${st.mtimeMs}:${st.size}:${cfg.section ?? ''}:${cfg.all_tables}:${cfg.id_column}:${cfg.date_column}:${cfg.text_column}:${cfg.source_column}:${cfg.id_prefix}`; } catch { return { entries: [], duplicates: [] }; }
  const hit = tableCache.get(cfg.file);
  if (hit && hit.sig === sig) return hit.read;
  const markdown = readFileSync(cfg.file, 'utf8');
  const wide = Math.max(cfg.id_column, cfg.text_column, cfg.date_column ?? 0, cfg.source_column ?? 0);
  let found: A.DecisionEntry[];
  if (cfg.all_tables) found = findTables(markdown).filter(tb => tb.header.length >= wide).flatMap(tb => rowsToEntries(cfg, tb.rows, tb.heading));
  else { const table = pickTable(markdown, cfg.section); found = table ? rowsToEntries(cfg, table.rows, table.heading) : []; }
  // the later entry of a number wins; a number in more than one place is reported
  const last = new Map<number, A.DecisionEntry>();
  const places = new Map<number, string[]>();
  for (const e of found) { last.set(e.number, e); (places.get(e.number) ?? places.set(e.number, []).get(e.number)!).push(e.topic ?? ''); }
  const duplicates = [...places.entries()].filter(([, topics]) => topics.length > 1).map(([n, topics]) => ({ id: idOf(cfg, n), topics }));
  const read = { entries: [...last.values()], duplicates };
  tableCache.set(cfg.file, { sig, read });
  return read;
}

/** All decisions, oldest first (by number). An entry made here wins over a table row with the same number. */
export function readLedger(cfg: DecisionsConfig): A.DecisionEntry[] {
  const own = readStored(cfg);
  const taken = new Set(own.map(e => e.number));
  return [...readTable(cfg).entries.filter(e => !taken.has(e.number)), ...own].sort((a, b) => a.number - b.number);
}

/** Numbers that appear in more than one place of the project's file. */
export const ledgerDuplicates = (cfg: DecisionsConfig): { id: string; topics: string[] }[] => readTable(cfg).duplicates;

/** `D2040-D2050`, `2040~2050`, `D2040 to D2050`: a range of numbers written in free text; none when there is no range. */
export function parseRange(text: string | undefined): [number, number] | undefined {
  if (!text) return undefined;
  const m = textConventions.decisions_1.exec(text);
  if (!m) return undefined;
  const a = Number(m[1]), b = Number(m[2]);
  return a <= b ? [a, b] : undefined;
}

const OPEN_STAGES = (doc: OrderDoc, orders: Orders) => !['merged', 'cancelled'].includes(orders.stage(doc).stage);

/** The ranges that open orders hold, from the `decisions` text of their mandate. */
export function reservedRanges(orders: Orders): { tag: string; range: [number, number] }[] {
  const out: { tag: string; range: [number, number] }[] = [];
  for (const doc of orders.all()) {
    const range = parseRange(doc.order.mandate?.decisions);
    if (range && OPEN_STAGES(doc, orders)) out.push({ tag: doc.order.tag, range });
  }
  return out;
}

export function decisionList(project: ProjectConfig, orders: Orders): A.DecisionList {
  const cfg = project.decisions;
  if (!cfg) return { project: project.id, count: 0, items: [], next: '', reserved: [], topics: [], duplicates: [] };
  const items = readLedger(cfg);
  const reserved = reservedRanges(orders);
  return { project: project.id, count: items.length, items, ...(cfg.reviewer_range ? { reviewerRange: cfg.reviewer_range } : {}), next: idOf(cfg, nextNumber(cfg, items, reserved)), reserved, topics: [...new Set(items.map(e => e.topic).filter((x): x is string => !!x))], duplicates: ledgerDuplicates(cfg) };
}

/** The lowest free number of the reviewer's range (when there is one), else one above the highest number used; numbers reserved on open orders are skipped. */
function nextNumber(cfg: DecisionsConfig, items: readonly A.DecisionEntry[], reserved: readonly { range: [number, number] }[], within?: [number, number]): number {
  const used = new Set(items.map(e => e.number));
  const blocked = (n: number) => reserved.some(r => n >= r.range[0] && n <= r.range[1]);
  const range = within ?? cfg.reviewer_range;
  if (range) {
    for (let n = range[0]; n <= range[1]; n++) if (!used.has(n) && (within || !blocked(n))) return n;
    return fail('No free number is left in the range {a}-{b}.', { a: idOf(cfg, range[0]), b: idOf(cfg, range[1]) });
  }
  let n = Math.max(0, ...items.map(e => e.number)) + 1;
  while (blocked(n)) n++;
  return n;
}

export interface NewDecision { text: string; source?: string; default?: boolean; date?: string; id?: string; order?: string }

/**
 * Records a decision. Its number is the given id, or the next free one: in the reviewer's range, or - for a decision made on behalf of
 * an order (`order`) - in the range reserved on that order. An id that is taken, that lies in a range reserved on another open order,
 * or (with a reviewer range configured) outside the range it may come from, is refused.
 */
export function addDecision(project: ProjectConfig, orders: Orders, input: NewDecision, now: Date = new Date()): A.DecisionEntry {
  return stateTransaction(project, () => {
    const cfg = project.decisions;
    if (!cfg) fail('{file} has no "decisions" section.', { file: project.file });
    if (!input.text?.trim()) fail('A decision needs its text.');
    if (input.default && input.source?.trim()) fail('A decision is either taken on the user\'s words (source) or by default, not both.');
    if (!input.default && !input.source?.trim()) fail('A decision needs the user\'s own words (source), or "default" when the user gave none.');
    const date = input.date ?? now.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('The date must be YYYY-MM-DD.');
    const items = readLedger(cfg);
    const reserved = reservedRanges(orders);
    let own: { tag: string; range: [number, number] } | undefined;
    if (input.order) {
      const doc = orders.get(input.order);
      own = reserved.find(r => r.tag === doc.order.tag);
      if (!own) fail('{tag} has no number range reserved (its mandate "decisions" names none), so it cannot take decisions.', { tag: doc.order.tag });
    }
    let number: number;
    if (input.id !== undefined) {
      const n = parseDecisionId(cfg, input.id);
      if (n === undefined) fail('"{id}" is not a decision id like {example}.', { id: input.id, example: idOf(cfg, 1) });
      number = n;
    } else number = nextNumber(cfg, items, reserved, own?.range);
    if (items.some(e => e.number === number)) fail('{id} is taken already.', { id: idOf(cfg, number) });
    if (own) {
      if (number < own.range[0] || number > own.range[1]) fail('{id} is outside the range {a}-{b} reserved on {tag}.', { id: idOf(cfg, number), a: idOf(cfg, own.range[0]), b: idOf(cfg, own.range[1]), tag: own.tag });
    } else {
      const hit = reserved.find(r => number >= r.range[0] && number <= r.range[1]);
      if (hit) fail('{id} is inside the range {a}-{b} reserved on {tag}, which is still open.', { id: idOf(cfg, number), a: idOf(cfg, hit.range[0]), b: idOf(cfg, hit.range[1]), tag: hit.tag });
      if (cfg.reviewer_range && (number < cfg.reviewer_range[0] || number > cfg.reviewer_range[1])) fail('{id} is outside the reviewer\'s range {a}-{b}.', { id: idOf(cfg, number), a: idOf(cfg, cfg.reviewer_range[0]), b: idOf(cfg, cfg.reviewer_range[1]) });
    }
    const at = orders.now();
    const entry: Stored = { id: idOf(cfg, number), number, date, text: input.text.trim(), source: input.default ? DEFAULT_SOURCE : input.source!.trim(), sourceKind: input.default ? 'default' : 'quote', by: orders.actor, at };
    const rel = path.relative(project.state_dir, cfg.store);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) appendStateFile(project, rel, JSON.stringify(entry) + '\n');
    else { mkdirSync(path.dirname(cfg.store), { recursive: true }); appendFileSync(cfg.store, JSON.stringify(entry) + '\n', 'utf8'); }
    orders.record(input.order ?? '*', 'decision', { id: entry.id, text: entry.text, source: entry.source, by: orders.actor });
    return { ...entry };
  });
}

/** The ledger entries an order names (by id) in its mandate, title, condition, quote or work-order file. */
export function referencedDecisions(project: ProjectConfig, doc: OrderDoc, fileText?: string): A.DecisionEntry[] {
  const cfg = project.decisions;
  if (!cfg) return [];
  const text = [doc.order.title, doc.order.condition, doc.order.mandate?.quote, doc.order.mandate?.decisions, fileText].filter(Boolean).join('\n');
  const ids = new Set([...text.matchAll(new RegExp(`(?<![A-Za-z0-9])${cfg.id_prefix}(\\d+)(?![A-Za-z0-9])`, 'g'))].map(m => Number(m[1])));
  if (!ids.size) return [];
  return readLedger(cfg).filter(e => ids.has(e.number));
}

export const formatDecisions = (items: readonly A.DecisionEntry[]): string =>
  items.length ? items.map(e => `${e.displayId ?? e.id}  ${e.date}  ${e.text}  [${e.sourceKind === 'default' ? t('default') : e.source}]`).join('\n') : t('(none)');
