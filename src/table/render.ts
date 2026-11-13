import type { TableConfig } from '../config.ts';
import type { OrderDoc, Stage } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { t } from '../i18n.ts';
import { formatRow, type MarkdownTable } from './markdown.ts';

interface TableMeta { header?: string[]; separator?: string }

const baseOf = (s: Stage): Stage => (s === 'waiting-needs' ? 'queued' : s);

/**
 * The status word for a stage: the word the table used at import if it still means this stage,
 * otherwise the first word in status_map that maps to it.
 */
export function wordFor(cfg: TableConfig, doc: OrderDoc, stage: Stage): string | undefined {
  const target = baseOf(stage);
  const original = doc.order.source?.status_word;
  if (original !== undefined && cfg.status_map[original] === target) return original;
  return Object.entries(cfg.status_map).find(([, s]) => s === target)?.[0];
}

/** One rendered table row. `row` is the 0-based data row it replaces, absent for an order that had no row. */
export interface RenderedRow { tag: string; row?: number; cells: string[]; text: string; /** false when no status word means the stage, so the word is a stand-in */ exact: boolean }

/**
 * Renders every order as a table row. With the `original` table, a row keeps the cells the tool has no say over
 * (columns other than status, order, worker and needs) exactly as they were.
 */
export function renderTable(orders: Orders, cfg: TableConfig, original?: MarkdownTable): { markdown: string; warnings: string[]; rows: RenderedRow[]; skipped: { tag: string; row: number }[] } {
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const meta = (orders.store.readMeta('table') ?? {}) as TableMeta;
  const columns = Math.max(cfg.status_column, cfg.order_column, cfg.worker_column ?? 0, cfg.needs_column ?? 0, meta.header?.length ?? 0, original?.header.length ?? 0);
  const warnings: string[] = [];
  const rows: RenderedRow[] = [];
  const skipped: { tag: string; row: number }[] = [];
  const inRow = (d: OrderDoc) => d.order.source?.row !== undefined;
  const rowDocs = docs.filter(inRow).sort((a, b) => a.order.source!.row! - b.order.source!.row!);
  const addedDocs = docs.filter(d => !inRow(d)).sort((a, b) => a.order.created.localeCompare(b.order.created));
  const lines: string[] = [];
  for (const d of [...rowDocs, ...addedDocs]) {
    const { stage } = orders.stage(d, merged);
    if (!inRow(d) && ['merged', 'cancelled'].includes(stage)) continue;   // finished orders that never had a row stay out
    let word = wordFor(cfg, d, stage);
    const exact = word !== undefined;
    if (word === undefined) {
      if (['merged', 'cancelled'].includes(stage)) { warnings.push(t('{tag} is {stage}, which has no status word; left out of the table.', { tag: d.order.tag, stage })); if (d.order.source?.row !== undefined) skipped.push({ tag: d.order.tag, row: d.order.source.row }); continue; }
      word = d.order.source?.status_word ?? stage;
      warnings.push(t('{tag}: no status word maps to {stage}; wrote "{word}".', { tag: d.order.tag, stage, word }));
    }
    const o = d.order;
    const base = original && o.source?.row !== undefined ? original.rows[o.source.row] : undefined;
    const cells: string[] = Array.from({ length: columns }, (_, i) => base?.[i] ?? '');
    cells[cfg.status_column - 1] = word;
    cells[cfg.order_column - 1] = o.source?.tagged === false ? o.title : `${o.tag}${o.source?.joiner ?? ' '}${o.title}`;
    if (cfg.worker_column) cells[cfg.worker_column - 1] = o.worker ?? '';
    if (cfg.needs_column) cells[cfg.needs_column - 1] = o.condition ?? o.needs.join(', ');
    const text = formatRow(cells);
    lines.push(text);
    rows.push({ tag: o.tag, row: o.source?.row, cells, text, exact });
  }
  const header = Array.from({ length: columns }, (_, i) => meta.header?.[i] ?? (i === cfg.status_column - 1 ? 'Status' : i === cfg.order_column - 1 ? 'Order' : i === (cfg.worker_column ?? 0) - 1 ? 'Worker' : i === (cfg.needs_column ?? 0) - 1 ? 'Needs' : ''));
  const separator = meta.separator ?? formatRow(header.map(() => '---')).replace(/ /g, '');
  return { markdown: [formatRow(header), separator, ...lines].join('\n') + '\n', warnings, rows, skipped };
}
