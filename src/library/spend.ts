import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { SpendApproval, SpendApproveRequest, SpendEntry, SpendQuote, SpendView } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { appendStateJsonl, isObject, isText, readJsonl, readStateJsonl, relTo, sha256, walk } from './files.ts';
import { sameFingerprint } from './picks.ts';

const NOTE_MAX = 4000;
/** The words a quote's `quote_status` is known to take. Any other word is shown as written and marked unknown. */
export const KNOWN_QUOTE_STATUS = ['exact', 'estimate', 'unknown', 'unknown_pricing_contract_expired'];
const EPS = 1e-6;
/** A file that keeps its own total rounds it (6.792 for 6.7925), so a total is compared with this much room. */
const ROUNDED = 0.005;
/** Of one kind of wallet finding, this many lines are listed; the rest is counted. */
const LISTED = 3;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const when = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : isText(v) ? v.trim() : undefined);

interface Approval { at: string; quote: string; fingerprint: string; cap: number; note?: string; by: string; source: 'alba' | 'external' }

/** Approvals of quote files: the external tool's (read only, `credits.records`) and alba's own (`_approvals.jsonl`), oldest first. */
export function approvalRecords(project: ProjectConfig): { records: Approval[]; problems: string[] } {
  const records: Approval[] = [];
  const problems: string[] = [];
  const external = readJsonl(project.credits?.records);
  problems.push(...external.problems);
  for (const { line, value: v } of external.items) {
    if (v.project !== undefined && v.project !== project.credits?.project_id) continue;
    if (!isText(v.quote) || !isText(v.fingerprint) || num(v.cap) === undefined || !isText(v.at) || !Number.isFinite(Date.parse(v.at))) { problems.push(`${path.basename(project.credits!.records!)}: line ${line} is not an approval (quote, fingerprint, cap, at)`); continue; }
    records.push({ at: v.at, quote: v.quote, fingerprint: v.fingerprint, cap: v.cap as number, ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'external', source: 'external' });
  }
  const own = readStateJsonl(project, 'approvals');
  problems.push(...own.problems);
  for (const { line, value: v } of own.items) {
    if (!isText(v.quote) || !isText(v.fingerprint) || num(v.cap) === undefined || !isText(v.at)) { problems.push(`_approvals.jsonl: line ${line} is not an approval`); continue; }
    records.push({ at: v.at, quote: v.quote, fingerprint: v.fingerprint, cap: v.cap as number, ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'cli', source: 'alba' });
  }
  return { records: records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), problems };
}

/**
 * The lines of a spend file, whichever way the file keeps them: `entries`, `spend`, `items` or `assets` (a list), at the top or as the
 * file itself. A line is whatever has an amount: `credits` (or `cost`, `amount`, `credits_accounted`, `accounting_credits`, `credits_consumed`); the wallet before and after are optional.
 */
export function spendEntries(value: unknown): { entries: SpendEntry[]; problems: string[]; declared: { spent?: number; cap?: number } } {
  const problems: string[] = [];
  const out: SpendEntry[] = [];
  const list = Array.isArray(value) ? value : isObject(value) ? (['entries', 'spend', 'items', 'assets', 'steps', 'rows'] as const).map(k => (value as Record<string, unknown>)[k]).find(Array.isArray) : undefined;
  const top = isObject(value) ? value : {};
  const total = (['spent', 'total', 'total_accounted', 'spend_credits', 'accounting_credits', 'credits_consumed'] as const).map(k => num(top[k])).find(v => v !== undefined);
  const declared = { ...(total !== undefined ? { spent: total } : {}), ...(num(top.cap) !== undefined ? { cap: num(top.cap) } : {}) };
  // a file that only says what was spent in total has no lines to list; its total is then the spend
  if (!list) { if (total === undefined) problems.push(t('no list of spend lines (entries, spend, items or assets)')); return { entries: out, problems, declared }; }
  let bare = 0;
  list.forEach((e, i) => {
    if (!isObject(e)) { problems.push(t('entries[{i}] is not a mapping', { i })); return; }
    const credits = num(e.credits) ?? num(e.cost) ?? num(e.amount) ?? num(e.credits_accounted) ?? num(e.accounting_credits) ?? num(e.credits_consumed);
    if (credits === undefined) { if (++bare <= LISTED) problems.push(t('entries[{i}] has no amount', { i })); return; }
    const entry: SpendEntry = { credits };
    const at = when(e.at); if (at) entry.at = at;
    const asset = isText(e.asset) ? e.asset : isText(e.id) ? e.id : undefined; if (asset) entry.asset = asset;
    if (isText(e.op)) entry.op = e.op;
    if (isText(e.order)) entry.order = e.order;
    if (isText(e.task)) entry.task = e.task;
    if (num(e.balance_before) !== undefined) entry.before = num(e.balance_before);
    if (num(e.balance_after) !== undefined) entry.after = num(e.balance_after);
    if (isText(e.status)) entry.status = e.status;
    if (isText(e.note)) entry.note = e.note;
    out.push(entry);
  });
  if (bare > LISTED) problems.push(t('{n} more lines without an amount', { n: bare - LISTED }));
  return { entries: out, problems, declared };
}

/** Checks of a spend file: before - after = credits, one line's "after" is the next one's "before", the total, the approved cap. Findings, never errors. */
export function checkSpend(entries: SpendEntry[], declared: { spent?: number }, cap?: number): { spent: number; problems: string[] } {
  const problems: string[] = [];
  // a wallet shared with other work moves on its own, so these findings can be on every line: the first few are listed, the rest counted
  const wallet = { fell: [] as string[], chain: [] as string[] };
  entries.forEach((e, i) => {
    if (e.before !== undefined && e.after !== undefined && Math.abs(e.before - e.after - e.credits) > EPS) wallet.fell.push(t('entries[{i}]: the wallet fell by {fell}, the line says {credits}', { i, fell: e.before - e.after, credits: e.credits }));
    const prev = entries[i - 1];
    if (prev?.after !== undefined && e.before !== undefined && Math.abs(prev.after - e.before) > EPS) wallet.chain.push(t('entries[{i}]: the wallet before ({before}) is not the one after the line before ({after})', { i, before: e.before, after: prev.after }));
  });
  for (const list of [wallet.fell, wallet.chain]) {
    problems.push(...list.slice(0, LISTED));
    if (list.length > LISTED) problems.push(t('{n} more lines like the ones above (a wallet that other work also draws on moves by itself)', { n: list.length - LISTED }));
  }
  const spent = entries.length || declared.spent === undefined ? entries.reduce((n, e) => n + e.credits, 0) : declared.spent;
  if (entries.length && declared.spent !== undefined && Math.abs(declared.spent - spent) > ROUNDED) problems.push(t('the file says {declared} were spent; its lines add up to {sum}', { declared: declared.spent, sum: spent }));
  if (cap !== undefined && spent > cap + EPS) problems.push(t('{spent} spent is over the approved cap of {cap}', { spent, cap }));
  return { spent, problems };
}

function quoteOf(project: ProjectConfig, rel: string, approvals: Approval[]): { quote?: SpendQuote; reason?: string } {
  const cfg = project.credits!;
  const full = path.join(cfg.dir, rel);
  const raw = readFileSync(full);
  let value: unknown;
  try { value = parse(raw.toString('utf8')); } catch (e) { return { reason: t('not valid YAML: {error}', { error: (e as Error).message.split('\n')[0] }) }; }
  if (!isObject(value)) return { reason: t('not a mapping') };
  if (!['id', 'service', 'cap_requested', 'total', 'items', 'quote_status'].some(k => k in value)) return { reason: t('not a quote (no id, service, items, total or cap_requested)') };
  const file = relTo(project.root, full);
  const id = isText(value.id) ? value.id.trim() : typeof value.id === 'number' ? String(value.id) : path.basename(rel).replace(/\.ya?ml$/i, '');
  const problems: string[] = [];
  const status = isText(value.quote_status) ? value.quote_status.trim() : undefined;
  const statusKnown = status === undefined ? true : KNOWN_QUOTE_STATUS.includes(status);
  if (status && !statusKnown) problems.push(t('the quote status "{status}" is not one of {list}', { status, list: KNOWN_QUOTE_STATUS.join(', ') }));
  const est = isObject(value.estimate) ? value.estimate : undefined;
  const perItem = est?.per_item ?? value.per_item;
  const estimate = est || perItem !== undefined ? {
    ...(typeof perItem === 'string' || num(perItem) !== undefined ? { perItem: perItem as string | number } : {}),
    ...(est && num(est.total) !== undefined ? { total: num(est.total) } : {}), ...(est && isText(est.basis) ? { basis: est.basis } : {}),
  } : undefined;
  const items = Array.isArray(value.items) ? value.items.length : num(value.items);
  const total = value.total === null ? null : num(value.total);
  if (status === 'exact' && Array.isArray(value.items)) {
    const sum = value.items.reduce((n: number, i) => n + (isObject(i) ? (num(i.credits) ?? NaN) : NaN), 0);
    if (total === null || total === undefined || Number.isNaN(sum) || Math.abs(sum - total) > EPS) problems.push(t('an exact quote needs an amount for every item that adds up to the total'));
  }
  const fingerprint = sha256(raw);
  const record = [...approvals].reverse().find(r => r.quote === id);
  const stale = Boolean(record) && !sameFingerprint(record!.fingerprint, raw.toString('utf8'));
  const approval: SpendApproval | undefined = record ? { cap: record.cap, ...(record.note ? { note: record.note } : {}), at: record.at, by: record.by, source: record.source, stale } : undefined;
  // the spend file next to the quote
  const candidates = [`${id}.spend.yaml`, `${path.basename(rel).replace(/\.ya?ml$/i, '')}.spend.yaml`, `${id}.spend.yml`].map(n => path.join(path.dirname(full), n));
  const spendPath = candidates.find(existsSync);
  let entries: SpendEntry[] = [];
  let declared: { spent?: number } = {};
  let spendFile: string | undefined;
  if (spendPath) {
    spendFile = relTo(project.root, spendPath);
    try {
      const read = spendEntries(parse(readFileSync(spendPath, 'utf8')));
      entries = read.entries; declared = read.declared;
      problems.push(...read.problems.map(p => `${path.basename(spendPath)}: ${p}`));
    } catch (e) { problems.push(t('{file}: not valid YAML: {error}', { file: path.basename(spendPath), error: (e as Error).message.split('\n')[0] })); }
  }
  const counted = approval && !approval.stale ? approval.cap : undefined;
  const checked = checkSpend(entries, declared, counted);
  problems.push(...checked.problems.map(p => (spendPath ? `${path.basename(spendPath)}: ${p}` : p)));
  const last = [...entries].reverse().find(e => e.after !== undefined)?.after;
  const quote: SpendQuote = {
    id, ...(isText(value.service) ? { service: value.service } : {}), ...(isText(value.order) ? { order: value.order } : {}), ...(when(value.created) ? { created: when(value.created) } : {}),
    ...(status ? { status } : {}), statusKnown, ...(items !== undefined ? { items } : {}), ...(total !== undefined ? { total } : {}), ...(estimate ? { estimate } : {}),
    ...(num(value.cap_requested) !== undefined ? { capRequested: num(value.cap_requested) } : {}), ...(typeof value.notes === 'string' && value.notes.trim() ? { notes: value.notes.trim() } : {}),
    file, fingerprint, state: !approval ? 'pending' : stale ? 'stale' : 'approved', ...(approval ? { approval } : {}), entries, ...(spendFile ? { spendFile } : {}),
    spent: checked.spent, ...(counted !== undefined ? { remaining: counted - checked.spent } : {}), ...(last !== undefined ? { balance: last } : num(value.balance_at_quote) !== undefined ? { balance: num(value.balance_at_quote) } : {}), problems,
  };
  return { quote };
}

/** The quote files of the project's credits folder with what was spent against each; nothing throws, every file is listed or named with the reason. */
export function spendView(project: ProjectConfig): SpendView {
  const empty: SpendView = { project: project.id, enabled: false, quotes: [], unreadable: [], recordProblems: [], counts: { quotes: 0, withProblems: 0, pending: 0, approved: 0, stale: 0, unreadable: 0 } };
  const cfg = project.credits;
  if (!cfg) return empty;
  const out: SpendView = { ...empty, enabled: true };
  if (!existsSync(cfg.dir)) { out.unreadable.push({ file: relTo(project.root, cfg.dir), reason: t('the folder is not there') }); out.counts.unreadable = 1; return out; }
  const { records, problems } = approvalRecords(project);
  out.recordProblems = problems;
  const seen = new Map<string, string>();
  for (const rel of walk(cfg.dir).filter(f => /\.ya?ml$/i.test(f) && !/\.spend\.ya?ml$/i.test(f))) {
    try {
      const { quote, reason } = quoteOf(project, rel, records);
      const file = relTo(project.root, path.join(cfg.dir, rel));
      if (!quote) { out.unreadable.push({ file, reason: reason! }); continue; }
      if (seen.has(quote.id)) { out.unreadable.push({ file, reason: t('the id "{id}" is the one of {file} too', { id: quote.id, file: seen.get(quote.id)! }) }); continue; }
      seen.set(quote.id, file);
      out.quotes.push(quote);
    } catch (e) { out.unreadable.push({ file: relTo(project.root, path.join(cfg.dir, rel)), reason: (e as Error).message }); }
  }
  out.quotes.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || a.id.localeCompare(b.id, undefined, { numeric: true }));
  out.counts = {
    quotes: out.quotes.length, withProblems: out.quotes.filter(q => q.problems.length).length, pending: out.quotes.filter(q => q.state === 'pending').length,
    approved: out.quotes.filter(q => q.state === 'approved').length, stale: out.quotes.filter(q => q.state === 'stale').length, unreadable: out.unreadable.length,
  };
  return out;
}

/** Approves a quote file up to a cap: a record of the file's fingerprint, the cap, who and when. A changed file needs a new approval. */
export function approveQuote(project: ProjectConfig, orders: Orders, id: string, req: SpendApproveRequest): SpendQuote {
  const view = spendView(project);
  if (!view.enabled) fail('The project file has no "credits" section.');
  const q = view.quotes.find(x => x.id.toLowerCase() === id.toLowerCase());
  if (!q) fail('There is no quote file "{id}".', { id });
  if (req.fingerprint !== undefined && req.fingerprint !== q.fingerprint) fail('The file of quote "{id}" changed; read it again before approving.', { id: q.id });
  if (typeof req.cap !== 'number' || !Number.isFinite(req.cap) || req.cap <= 0) fail('A cap above 0 is needed.');
  if (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > NOTE_MAX)) fail('The note is text of at most {n} characters.', { n: NOTE_MAX });
  const note = req.note?.trim() || undefined;
  const who = req.who?.trim() || undefined;
  appendStateJsonl(project, 'approvals', { at: orders.now(), quote: q.id, fingerprint: q.fingerprint, cap: req.cap, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  orders.record('*', 'spend-approved', { quote: q.id, cap: req.cap, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  return spendView(project).quotes.find(x => x.id === q.id)!;
}
