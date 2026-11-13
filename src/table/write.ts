import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TableConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { importTable } from './import.ts';
import { pickTable, tableFingerprint } from './markdown.ts';
import { renderTable } from './render.ts';
import { fileKey } from '../orders/state-files.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';

export interface WriteBackResult {
  text: string;
  changed: string[];      // tags whose row was rewritten
  added: string[];        // tags that had no row and got one at the end
  kept: string[];         // tags that have a row that was left as written (no status word could be found, or nothing to change)
  warnings: string[];
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((cell, i) => cell === b[i]);

/**
 * The file's text with the one table replaced by what the orders say. Everything outside that table, the table's
 * header and separator, and every row that already says the right thing stay exactly as they were (line endings too).
 * A row the tool cannot express (a merged order has no status word) is kept as written, never dropped.
 */
export function writeBackText(orders: Orders, cfg: TableConfig, text: string): WriteBackResult {
  const table = pickTable(text, cfg.section);
  if (!table) fail('No table found in {file}{section}.', { file: cfg.file, section: cfg.section ? ` under a heading containing "${cfg.section}"` : '' });
  const meta = (orders.store.readMeta('table') ?? {}) as { fingerprint?: string };
  if (!meta.fingerprint) fail('The table has not been imported by this version yet; run "alba table import" first.');
  if (meta.fingerprint !== tableFingerprint(table)) fail('The table in {file} changed since the last import; run "alba table import" first so that nothing a person wrote is lost.', { file: cfg.file });

  const rendered = renderTable(orders, cfg, table);
  const parts = text.split(/(\r?\n)/);
  const lines: string[] = [], eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) { lines.push(parts[i]); eols.push(parts[i + 1] ?? ''); }
  const eol = eols.find(e => e) ?? '\n';
  const result: WriteBackResult = { text, changed: [], added: [], kept: [], warnings: rendered.warnings };

  table.rows.forEach((cells, k) => {
    const entry = rendered.rows.find(r => r.row === k);
    const skipped = rendered.skipped.find(s => s.row === k);
    const idx = table.rowLines[k] - 1;
    if (!entry) { if (skipped) result.kept.push(skipped.tag); return; }
    if (!entry.exact) { result.kept.push(entry.tag); return; }       // no word means this stage: do not invent one
    if (same(cells, entry.cells.map(c => c.trim()))) { result.kept.push(entry.tag); return; }
    lines[idx] = entry.text;
    result.changed.push(entry.tag);
  });
  const added = rendered.rows.filter(r => r.row === undefined && r.exact);
  if (added.length) {
    const last = table.rowLines.at(-1) ?? table.startLine + 1;       // 1-based line of the last table line
    const hadEol = eols[last - 1] !== '';
    lines.splice(last, 0, ...added.map(r => r.text));
    eols.splice(last, 0, ...added.map(() => eol));
    if (!hadEol) { eols[last - 1] = eol; eols[last + added.length - 1] = ''; }
    result.added = added.map(r => r.tag);
  }
  result.text = lines.map((l, i) => l + eols[i]).join('');
  return result;
}

/** Writes the table back into a file, after copying the file to `<state_dir>/backups/`. Returns the backup's path. */
export function writeBack(orders: Orders, cfg: TableConfig, file: string, stateDir: string, now: Date): { backup: string } & WriteBackResult {
  const result = writeBackText(orders, cfg, readFileSync(file, 'utf8'));
  const backups = path.join(stateDir, 'backups');

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backups, `${path.basename(file)}.${stamp}.bak`);
  if (orders.store instanceof SqliteStore) orders.store.writeMeta(fileKey(`backups/${path.basename(backup)}`), readFileSync(file, 'utf8'));
  else { mkdirSync(backups, { recursive: true }); copyFileSync(file, backup); }
  writeFileSync(file, result.text, 'utf8');
  // Read the written table back: rows that were added now have a place in it, and the fingerprint matches the new text.
  importTable(orders, { ...cfg, file }, result.text, { workerEdits: false });
  return { backup, ...result };
}
