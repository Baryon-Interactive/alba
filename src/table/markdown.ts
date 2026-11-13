import { createHash } from 'node:crypto';

/** A pipe table found in a Markdown file. Cells are trimmed but otherwise kept exactly as written. */
export interface MarkdownTable {
  heading?: string;       // the nearest heading above the table
  startLine: number;      // 1-based line of the header row
  header: string[];
  separator: string;      // the separator row as written
  rows: string[][];
  rowLines: number[];     // 1-based line number of each data row
}

const SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Splits one table line into cells. A pipe written as `\|` stays inside its cell. */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map(c => c.trim());
}

export function findTables(markdown: string): MarkdownTable[] {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { heading = h[1].trim(); continue; }
    if (!line.trim().startsWith('|') || !SEPARATOR.test(lines[i + 1] ?? '') || !(lines[i + 1] ?? '').includes('|')) continue;
    const table: MarkdownTable = { heading, startLine: i + 1, header: splitRow(line), separator: lines[i + 1].trim(), rows: [], rowLines: [] };
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) { table.rows.push(splitRow(lines[j])); table.rowLines.push(j + 1); j++; }
    tables.push(table);
    i = j - 1;
  }
  return tables;
}

/** The first table, or the first table under a heading that contains `section`. */
export function pickTable(markdown: string, section?: string): MarkdownTable | undefined {
  const tables = findTables(markdown);
  return section ? tables.find(t => t.heading?.includes(section)) : tables[0];
}

export function formatRow(cells: readonly string[]): string {
  return `|${cells.map(c => (c ? ` ${c} ` : ' ')).join('|')}|`;
}

/** A short fingerprint of a table as written, to notice that a person edited it after the last import. */
export function tableFingerprint(table: MarkdownTable): string {
  return createHash('sha1').update(JSON.stringify([table.header, table.separator, table.rows])).digest('hex').slice(0, 16);
}
