import { createHash } from 'node:crypto';
import type { TableConfig } from '../config.ts';
import type { ImportSource, Stage } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { fail, t } from '../i18n.ts';
import { pickTable, tableFingerprint } from './markdown.ts';

export interface ImportResult {
  rows: number;                // data rows in the table
  created: string[];
  updated: string[];
  unchanged: string[];
  mergedFromList: string[];    // orders created from the "already merged" line
  warnings: string[];
}

interface Parsed {
  tag: string;
  title: string;
  worker?: string;
  condition?: string;
  needs: string[];
  kind?: string;
  heavy?: string;
  uses: string[];              // resources the kind rules say the row uses
  ruleTags: string[];          // tags the kind rules add to the row (words of the project's vocabulary, or any words)
  base?: string;               // branch the order starts from, when the row says so
  asserted: string[];          // tags the needs cell says are already merged
  word: string;
  /** An awaiting-user row whose word says a card waits for a click. */
  card: boolean;
  stage: Stage;
  source: ImportSource;
}

/** Global, word-bounded matcher for tags inside free text. */
export function tagMatcher(cfg: TableConfig): { all: (text: string) => string[]; leading: (text: string) => string | undefined; before: (text: string, marker: string) => string[]; needs: (text: string, markers: readonly string[]) => string[] } {
  const exclude = cfg.tag_exclude ? new RegExp(cfg.tag_exclude) : undefined;
  const inner = `(?<![A-Za-z0-9])(?:${cfg.tag_pattern})(?![A-Za-z0-9])`;
  const ok = (tag: string) => !(exclude && exclude.test(tag));
  return {
    // Tags written directly before the marker: "A, B <marker>" gives A and B.
    before: (text, marker) => {
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const group = new RegExp(`((?:${inner})(?:[\\s,,,/]+(?:${inner}))*)\\s*${escaped}`, 'g');
      return [...text.matchAll(group)].flatMap(m => [...m[1].matchAll(new RegExp(inner, 'g'))].map(x => x[0])).filter(ok);
    },
    // Only what a condition cell says outright: a plain list of tags, or tags written right before a marker ("X merged", "after X" styles).
    // A tag that is merely mentioned ("X delivered (not merged)") is not a need.
    needs: (text, markers) => {
      const sep = String.raw`(?:[\s,,,/]|\band\b)+`;
      const plain = text.trim().replace(/[..;;]+$/, '');
      if (new RegExp(`^(?:${inner})(?:${sep}(?:${inner}))*$`).test(plain)) return [...new Set([...plain.matchAll(new RegExp(inner, 'g'))].map(m => m[0]).filter(ok))];
      const found = markers.flatMap(marker => {
        const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const group = new RegExp(`((?:${inner})(?:${sep}(?:${inner}))*)\\s*${escaped}`, 'g');
        return [...text.matchAll(group)].flatMap(m => [...m[1].matchAll(new RegExp(inner, 'g'))].map(x => x[0])).filter(ok);
      });
      return [...new Set(found)];
    },
    all: text => [...new Set([...text.matchAll(new RegExp(inner, 'g'))].map(m => m[0]).filter(ok))],
    leading: text => {
      const m = new RegExp(`^(?:${cfg.tag_pattern})(?![A-Za-z0-9])`).exec(text);
      return m && ok(m[0]) ? m[0] : undefined;
    },
  };
}

function parseRows(cfg: TableConfig, markdown: string): { parsed: Parsed[]; table: NonNullable<ReturnType<typeof pickTable>> } {
  const table = pickTable(markdown, cfg.section);
  if (!table) fail('No table found in {file}{section}.', { file: cfg.file, section: cfg.section ? ` under a heading containing "${cfg.section}"` : '' });
  const tags = tagMatcher(cfg);
  const need = Math.max(cfg.status_column, cfg.order_column, cfg.worker_column ?? 0, cfg.needs_column ?? 0);
  const problems: string[] = [];
  const unmapped = new Map<string, number[]>();
  const parsed: Parsed[] = [];
  table.rows.forEach((cells, index) => {
    const line = table.rowLines[index];
    if (cells.length < need) { problems.push(t('line {line}: the row has {n} columns, the configuration needs at least {need}.', { line, n: cells.length, need })); return; }
    const word = cells[cfg.status_column - 1];
    const stage = cfg.status_map[word];
    if (!stage) { unmapped.set(word, [...(unmapped.get(word) ?? []), line]); return; }
    const cell = cells[cfg.order_column - 1];
    let tag = tags.leading(cell);
    let title: string, joiner = ' ', tagged = true;
    if (tag) {
      const rest = cell.slice(tag.length);
      joiner = /^\s/.test(rest) ? ' ' : '';
      title = rest.trim();
    } else {
      if (cfg.untagged === 'error') { problems.push(t('line {line}: the order cell does not start with a tag: {cell}', { line, cell: cell.slice(0, 40) })); return; }
      tag = `X-${createHash('sha1').update(cell).digest('hex').slice(0, 6)}`;
      title = cell; tagged = false;
    }
    if (!title) title = tag;
    const condition = cfg.needs_column ? cells[cfg.needs_column - 1] : undefined;
    // With `needs_markers` configured only plain tag lists and "X <marker>" count; without it every tag in the cell does.
    const markers = [...(cfg.needs_markers ?? []), ...(cfg.needs_markers?.length && cfg.merged_marker ? [cfg.merged_marker] : [])];
    const needs = condition ? (markers.length ? tags.needs(condition, markers) : tags.all(condition)).filter(n => n !== tag) : [];
    const base = cfg.base_pattern ? new RegExp(cfg.base_pattern).exec(cells.join(' | '))?.[1] : undefined;
    let kind: string | undefined, heavy: string | undefined;
    const ruleTags: string[] = [];
    const uses: string[] = [];
    for (const rule of cfg.kind_rules) {
      if (!new RegExp(rule.match).test(cells.join(' '))) continue;
      kind ??= rule.kind; heavy ??= rule.heavy;
      for (const u of rule.uses ?? []) if (!uses.includes(u)) uses.push(u);
      for (const tag of rule.tags ?? []) if (!ruleTags.includes(tag)) ruleTags.push(tag);
    }
    const asserted = cfg.merged_marker && condition ? tags.before(condition, cfg.merged_marker) : [];
    const worker = cfg.worker_column ? cells[cfg.worker_column - 1] : undefined;
    parsed.push({ tag, title, worker: worker || undefined, condition: condition || undefined, needs, kind, heavy, uses, ruleTags, base, asserted, word, card: stage === 'awaiting-user' && !!cfg.card_words?.includes(word), stage, source: { status_word: word, ...(cfg.worker_column ? { worker_cell: worker ?? '' } : {}), row: index, tagged, joiner } });
  });
  for (const [word, lines] of unmapped) problems.push(t('status word "{word}" (line {lines}) is not in status_map; add it or fix the table.', { word, lines: lines.join(', ') }));
  const seen = new Map<string, number>();
  for (const p of parsed) {
    if (seen.has(p.tag)) problems.push(t('tag {tag} appears in two rows (lines {a} and {b}).', { tag: p.tag, a: table.rowLines[seen.get(p.tag)!], b: table.rowLines[p.source.row!] }));
    seen.set(p.tag, p.source.row!);
  }
  if (problems.length) fail('The table cannot be imported ({n} problem(s)); nothing was written:\n  - {list}', { n: problems.length, list: problems.join('\n  - ') });
  return { parsed, table };
}

/** Makes the order's facts agree with the stage the table claims, by recording what a person or worker would have recorded. */
function applyStage(orders: Orders, p: Parsed, workerFallback: string): void {
  const doc = orders.get(p.tag);
  const current = orders.stage(doc).stage;
  const base = (s: Stage) => (s === 'waiting-needs' ? 'queued' : s);
  const note = t('imported from the dispatch table');
  const reportOf = (status: 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped', question?: string, waiting_for?: 'card' | 'answer') =>
    orders.report(p.tag, { status, summary: note, ...(question ? { question } : {}), ...(waiting_for ? { waiting_for } : {}), evidence: [], commits: [] }, 'import', true);
  const waiting = () => (p.card ? reportOf('waiting', t('A card waits for your click (imported from the dispatch table).'), 'card') : reportOf('waiting', t('Waiting for your answer or click (imported from the dispatch table).')));
  if (base(current) === base(p.stage)) {
    // Same stage, but the table may say a different thing is waited for (the configuration gained card_words, or the word changed within awaiting-user): say it again.
    if (p.stage === 'awaiting-user') {
      const have = orders.stage(doc).waitingFor;
      const latest = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
      if (latest?.imported && have !== (p.card ? 'card' : 'answer')) waiting();
    }
    return;
  }
  switch (p.stage) {
    case 'draft': return;   // facts cannot be taken back; a draft row for an order that moved on is left alone
    case 'queued': orders.act(p.tag, 'queue', { force: true, imported: true }); return;
    case 'running': orders.runStart(p.tag, { worker: p.worker || workerFallback }, true); return;
    case 'awaiting-user': waiting(); return;
    case 'awaiting-review': reportOf('ready'); return;
    case 'blocked': case 'failed': case 'dropped': reportOf(p.stage); return;
    case 'held': orders.act(p.tag, 'hold', { force: true, imported: true }); return;
    case 'merged': orders.act(p.tag, 'approve', { force: true, imported: true }); return;
    case 'cancelled': orders.act(p.tag, 'cancel', { force: true, imported: true }); return;
    default: return;
  }
}

function mergedListTags(cfg: TableConfig, markdown: string): string[] {
  if (!cfg.merged_list) return [];
  const line = markdown.split(/\r?\n/).map(l => l.replace(/^[\s*>-]+/, '')).find(l => l.startsWith(cfg.merged_list!.prefix));
  if (!line) return [];
  const body = line.slice(cfg.merged_list.prefix.length).split(/[((]/)[0];
  return tagMatcher(cfg).all(body);
}

/** Reads the configured table and writes order state. The Markdown file is never changed. */
export function importTable(orders: Orders, cfg: TableConfig, markdown: string, options: { /** Readback of our own write is not a person's worker edit. */ workerEdits?: boolean } = {}): ImportResult {
  const { parsed, table } = parseRows(cfg, markdown);
  const result: ImportResult = { rows: parsed.length, created: [], updated: [], unchanged: [], mergedFromList: [], warnings: [] };
  const kind = cfg.default_kind ?? '';
  for (const p of parsed) {
    const existing = orders.resolveTag(p.tag);
    if (!existing) {
      orders.add({ tag: p.tag, title: p.title, kind: p.kind ?? kind, heavy: p.heavy, uses: p.uses, tags: p.ruleTags, base_ref: p.base, needs: p.needs, worker: p.worker, condition: p.condition, source: p.source });
      applyStage(orders, p, 'unknown');
      result.created.push(p.tag);
      continue;
    }
    const doc = orders.get(existing);
    const wordChanged = doc.order.source?.status_word !== p.word;
    const workerChanged = options.workerEdits !== false && !!cfg.worker_column && p.source.worker_cell !== (doc.order.source?.worker_cell ?? doc.order.worker ?? '');
    const before = JSON.stringify([doc.order.title, doc.order.worker, doc.order.needs, doc.order.condition, doc.order.source, doc.order.kind, doc.order.heavy, doc.order.base_ref]);
    const tagsNow = doc.order.tags ?? [];
    const withRuleTags = p.ruleTags.filter(x => !tagsNow.includes(x.toLowerCase()));
    const usesNow = doc.order.uses ?? [];
    const withUses = p.uses.filter(x => !usesNow.includes(x));
    orders.update(existing, { ...(withUses.length ? { uses: [...usesNow, ...withUses] } : {}), ...(withRuleTags.length ? { tags: [...tagsNow, ...withRuleTags.map(x => x.toLowerCase())] } : {}), title: p.title, ...(workerChanged ? { worker: p.worker } : {}), needs: p.needs, condition: p.condition, source: p.source, ...(p.kind ? { kind: p.kind } : {}), ...(p.heavy ? { heavy: p.heavy } : {}), ...(p.base ? { base_ref: p.base } : {}) });
    if (wordChanged || p.stage === 'awaiting-user') applyStage(orders, p, 'unknown');
    const after = orders.get(existing);
    (before !== JSON.stringify([after.order.title, after.order.worker, after.order.needs, after.order.condition, after.order.source, after.order.kind, after.order.heavy, after.order.base_ref]) || wordChanged ? result.updated : result.unchanged).push(existing);
  }
  const rowTags = new Set(parsed.map(p => p.tag.toLowerCase()));
  const claimedMerged = [...new Set([...mergedListTags(cfg, markdown), ...parsed.flatMap(p => p.asserted)])];
  for (const tag of claimedMerged) {
    if (rowTags.has(tag.toLowerCase())) { result.warnings.push(t('{tag} is claimed merged but is also a table row; the row wins.', { tag })); continue; }
    const existing = orders.resolveTag(tag);
    if (existing) {
      if (orders.stage(orders.get(existing)).stage !== 'merged') result.warnings.push(t('{tag} is in the merged list but its stored stage is {stage}; left as it is.', { tag: existing, stage: orders.stage(orders.get(existing)).stage }));
      continue;
    }
    orders.add({ tag, title: tag, kind, source: { from_merged_list: true } });
    orders.act(tag, 'approve', { force: true, imported: true });
    result.mergedFromList.push(tag);
  }
  const all = orders.all();
  const known = new Set(all.map(d => d.order.tag.toLowerCase()));
  for (const d of all) {
    const dangling = d.order.needs.filter(n => !known.has(n.toLowerCase()));
    if (dangling.length) result.warnings.push(t('{tag} needs {needs}, which is not a known order (it can never count as merged).', { tag: d.order.tag, needs: dangling.join(', ') }));
  }
  orders.store.writeMeta('table', { header: table.header, separator: table.separator, file: cfg.file, heading: table.heading, fingerprint: tableFingerprint(table) });
  return result;
}
