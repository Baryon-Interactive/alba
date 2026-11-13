import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { PickChoice, PickChooseRequest, PickChooseResult, PickList, PickOption, PickSet } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { readLedger } from '../ledger/decisions.ts';
import { optionAnswer } from '../orders/service.ts';
import type { Orders } from '../orders/service.ts';
import { appendStateJsonl, cleanRel, isObject, isText, readJsonl, readStateJsonl, relTo, safeFile, sha256, walk } from './files.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NOTE_MAX = 4000;

interface Record_ { at: string; set: string; fingerprint: string; choice: string[]; note?: string; by: string; who?: string; source: 'alba' | 'external' }

/** The same file with the line endings a checkout may have changed: a fingerprint made on one still matches the other. */
export function sameFingerprint(recorded: string, raw: string): boolean {
  const lf = raw.replace(/\r\n/g, '\n');
  return [raw, lf, lf.replace(/\n/g, '\r\n')].some(s => sha256(s) === recorded);
}

/** The choices on record: the external tool's (read only) and alba's own, oldest first. Lines that cannot be read are listed, not fatal. */
export function pickRecords(project: ProjectConfig): { records: Record_[]; problems: string[] } {
  const records: Record_[] = [];
  const problems: string[] = [];
  const external = readJsonl(project.picks?.records);
  problems.push(...external.problems);
  for (const { line, value: v } of external.items) {
    if (v.project !== undefined && v.project !== project.picks?.project_id) continue;
    if (!isText(v.set) || !isText(v.fingerprint) || !Array.isArray(v.choice) || !v.choice.every(isText) || !isText(v.at) || !Number.isFinite(Date.parse(v.at))) { problems.push(`${path.basename(project.picks!.records!)}: line ${line} is not a choice (set, fingerprint, choice, at)`); continue; }
    records.push({ at: v.at, set: v.set, fingerprint: v.fingerprint, choice: v.choice as string[], ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'external', source: 'external' });
  }
  const own = readStateJsonl(project, 'picks');
  problems.push(...own.problems);
  for (const { line, value: v } of own.items) {
    if (!isText(v.set) || !isText(v.fingerprint) || !Array.isArray(v.choice) || !v.choice.every(isText) || !isText(v.at)) { problems.push(`_picks.jsonl: line ${line} is not a choice`); continue; }
    records.push({ at: v.at, set: v.set, fingerprint: v.fingerprint, choice: v.choice as string[], ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'cli', ...(typeof v.who === 'string' ? { who: v.who } : {}), source: 'alba' });
  }
  return { records: records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), problems };
}

const decisionsText = (project: ProjectConfig): string => {
  const cfg = project.decisions;
  if (!cfg) return '';
  let text = '';
  try { if (cfg.file && existsSync(cfg.file)) text += readFileSync(cfg.file, 'utf8') + '\n'; } catch { /* unreadable: no decision found in it */ }
  try { text += readLedger(cfg).map(e => e.text).join('\n'); } catch { /* the ledger has its own problems list */ }
  return text;
};

const mentions = (text: string, id: string): boolean => new RegExp(`picks:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(text);

function imageList(project: ProjectConfig, paths: unknown, problems: string[], where: string, extraRoots: string[] = []): { path: string; exists: boolean }[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) { problems.push(t('{where}: "images" is not a list', { where })); return []; }
  return paths.map(p => {
    if (!cleanRel(p)) { problems.push(t('{where}: the picture path "{path}" is not a path inside the project', { where, path: String(p) })); return { path: String(p), exists: false }; }
    const exists = [project.root, ...extraRoots].some(r => safeFile(r, p) !== undefined);
    if (!exists) problems.push(t('{where}: the picture {path} is missing', { where, path: p }));
    return { path: p, exists };
  });
}

function fileSet(project: ProjectConfig, rel: string): { set?: PickSet; raw?: string; reason?: string } {
  const full = path.join(project.picks!.dir, rel);
  let raw: Buffer;
  try { raw = readFileSync(full); } catch (e) { return { reason: (e as Error).message }; }
  let value: unknown;
  try { value = parse(raw.toString('utf8')); } catch (e) { return { reason: t('not valid YAML: {error}', { error: (e as Error).message.split('\n')[0] }) }; }
  if (!isObject(value)) return { reason: t('not a mapping') };
  if (typeof value.id !== 'string' || !ID.test(value.id)) return { reason: t('"id" is missing or not letters, digits, "-" and "_"') };
  if (!Array.isArray(value.options) || !value.options.length) return { reason: t('"options" is missing or empty') };
  const problems: string[] = [];
  const keys = new Set<string>();
  const options: PickOption[] = [];
  value.options.forEach((o, i) => {
    const where = t('option {n}', { n: i + 1 });
    if (!isObject(o)) { problems.push(t('{where} is not a mapping', { where })); return; }
    const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : typeof o.key === 'number' ? String(o.key) : '';
    if (!key) { problems.push(t('{where} has no key', { where })); return; }
    if (keys.has(key)) { problems.push(t('the key "{key}" is used twice', { key })); return; }
    keys.add(key);
    options.push({ key, label: isText(o.label) ? o.label : key, images: imageList(project, o.images, problems, `"${key}"`), ...(isText(o.note) ? { note: o.note } : {}) });
  });
  if (!options.length) return { reason: t('no option has a key') };
  const base = relTo(project.root, full);
  const title = isText(value.title) ? value.title : value.id;
  const set: PickSet = {
    id: value.id, title, question: isText(value.question) ? value.question : title, ...(isText(value.order) ? { order: value.order } : {}),
    multi: value.multi === true, options, state: 'pending', ...(isText(value.decision) ? { decision: value.decision } : {}),
    file: base, fingerprint: sha256(raw), source: 'file', problems,
  };
  return { set, raw: raw.toString('utf8') };
}

function reportSets(project: ProjectConfig, orders: Orders): PickSet[] {
  const out: PickSet[] = [];
  for (const doc of orders.all()) {
    const last = doc.reports[doc.reports.length - 1];
    for (const r of doc.reports) {
      if (r.scope !== 'project' || !r.question || !r.options?.length) continue;
      const id = `${doc.order.tag}-r${r.seq}`;
      const problems: string[] = [];
      const options: PickOption[] = r.options.map((o, i) => ({ key: String(i + 1), label: o.label, images: imageList(project, o.images, problems, `"${o.label}"`, doc.order.worktree ? [doc.order.worktree] : []), ...(o.note ? { note: o.note } : {}) }));
      out.push({
        id, title: r.summary, question: r.question, order: doc.order.tag, multi: false, options, state: 'pending',
        fingerprint: sha256(JSON.stringify({ q: r.question, o: r.options })), source: 'report', ...(last === r && ['waiting', 'blocked'].includes(r.status) ? { waitingOrder: doc.order.tag } : {}), problems,
      });
    }
  }
  return out;
}

function choiceOf(rec: Record_ | undefined, set: PickSet, raw: string | undefined): PickChoice | undefined {
  if (!rec) return undefined;
  const known = new Set(set.options.map(o => o.key));
  const stale = (raw !== undefined ? !sameFingerprint(rec.fingerprint, raw) : rec.fingerprint !== set.fingerprint) || !rec.choice.every(k => known.has(k));
  return { choice: rec.choice, ...(rec.note ? { note: rec.note } : {}), at: rec.at, by: rec.by, ...(rec.who ? { who: rec.who } : {}), source: rec.source, stale };
}

function draft(set: PickSet): string {
  const labels = set.choice!.choice.map(k => set.options.find(o => o.key === k)?.label ?? k);
  return `${set.title}: ${labels.join(', ')}${set.choice!.note ? ` (${set.choice!.note.trim().replace(/\s+/g, ' ')})` : ''}. picks:${set.id}`;
}

/** Every pick set of the project, with its state. Nothing here throws on a bad file: the file is listed with what is wrong. */
export function listPicks(project: ProjectConfig, orders: Orders): PickList {
  const sets: PickSet[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  const raws = new Map<string, string>();
  if (project.picks && existsSync(project.picks.dir)) {
    const seen = new Map<string, string>();
    for (const rel of walk(project.picks.dir).filter(f => /\.ya?ml$/i.test(f) && !/\.spend\.ya?ml$/i.test(f))) {
      const { set, raw, reason } = fileSet(project, rel);
      const file = relTo(project.root, path.join(project.picks.dir, rel));
      if (!set) { unreadable.push({ file, reason: reason! }); continue; }
      if (seen.has(set.id)) { unreadable.push({ file, reason: t('the id "{id}" is the one of {file} too', { id: set.id, file: seen.get(set.id)! }) }); continue; }
      seen.set(set.id, file);
      raws.set(set.id, raw!);
      sets.push(set);
    }
  } else if (project.picks) {
    unreadable.push({ file: relTo(project.root, project.picks.dir), reason: t('the folder is not there') });
  }
  const own = reportSets(project, orders).filter(s => !sets.some(x => x.id === s.id));
  const { records, problems: recordProblems } = pickRecords(project);
  const ledger = decisionsText(project);
  const all = [...sets, ...own].filter(s => s.source === 'file' || s.waitingOrder || records.some(r => r.set === s.id));
  for (const set of all) {
    const mine = records.filter(r => r.set === set.id);
    const newest = mine[mine.length - 1];
    const c = choiceOf(newest, set, raws.get(set.id));
    const decided = Boolean(set.decision) || mentions(ledger, set.id);
    // A decided set is only looked at: the choice stays as history (the file got its decision line after the choice), not as a warning.
    if (c && (!c.stale || decided)) set.choice = c;
    else if (c) set.staleChoice = c;
    set.state = decided ? 'decided' : set.choice ? 'chosen' : 'pending';
    if (set.state === 'chosen') set.decisionDraft = draft(set);
  }
  const counts = { pending: 0, chosen: 0, decided: 0, unreadable: unreadable.length };
  for (const s of all) counts[s.state]++;
  const order = { pending: 0, chosen: 1, decided: 2 } as const;
  all.sort((a, b) => order[a.state] - order[b.state] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { project: project.id, enabled: Boolean(project.picks) || own.length > 0, sets: all, unreadable, recordProblems, counts };
}

/** Records a choice (in the state folder), and answers the order that waits on the question when the set came from its report. */
export function choosePick(project: ProjectConfig, orders: Orders, id: string, req: PickChooseRequest): PickChooseResult {
  const list = listPicks(project, orders);
  const set = list.sets.find(s => s.id.toLowerCase() === id.toLowerCase());
  if (!set) fail('There is no pick set "{id}".', { id });
  if (set.state === 'decided') fail('"{id}" is decided already; it can only be looked at.', { id: set.id });
  if (req.fingerprint !== undefined && req.fingerprint !== set.fingerprint) fail('The file of "{id}" changed; reload and choose again.', { id: set.id });
  if (!Array.isArray(req.choice) || !req.choice.length || req.choice.some(k => typeof k !== 'string') || new Set(req.choice).size !== req.choice.length) fail('"choice" must be a list of option keys.');
  if (req.choice.some(k => !set.options.some(o => o.key === k))) fail('"choice" names an option that "{id}" does not have.', { id: set.id });
  if (!set.multi && req.choice.length !== 1) fail('"{id}" takes one choice; {n} were given.', { id: set.id, n: req.choice.length });
  if (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > NOTE_MAX)) fail('The note is text of at most {n} characters.', { n: NOTE_MAX });
  const note = req.note?.trim() || undefined;
  const who = req.who?.trim() || undefined;
  const at = orders.now();
  appendStateJsonl(project, 'picks', { at, set: set.id, fingerprint: set.fingerprint, choice: req.choice, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  orders.record('*', 'pick-chosen', { set: set.id, choice: req.choice, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  let answeredOrder: string | undefined;
  if (set.source === 'report' && set.waitingOrder) {
    const doc = orders.get(set.waitingOrder);
    const now = orders.stage(doc);
    if (now.stage === 'awaiting-user' && now.waitingFor !== 'card') {
      const n = Number(req.choice[0]);
      orders.act(set.waitingOrder, 'answer', { note: optionAnswer(doc.reports.find(r => `${doc.order.tag}-r${r.seq}` === set.id)!.options![n - 1], n, note), choice: n });
      answeredOrder = set.waitingOrder;
    }
  }
  const after = listPicks(project, orders).sets.find(s => s.id === set.id)!;
  return { set: after, ...(answeredOrder ? { answeredOrder } : {}) };
}
