import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesignDocEntry, ProjectConfig } from '../config.ts';
import { backendName, stateStore } from '../orders/backend.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import type { Orders } from '../orders/service.ts';
import { DesignError } from './model.ts';
import { applyChangeSet, readChangeSet, readLibrary, stableJson } from './library.ts';
import { entityId, DESIGN_KINDS } from './model.ts';
import { readLedger } from '../ledger/decisions.ts';
import { excludeLocally } from '../skills/mount.ts';

export type DesignDocStatus = 'approved' | 'draft' | 'retired';
export interface DesignDocBlock { id: string; heading_path: string[]; text: string; level: number }
export interface DesignDocVersion { doc_id: string; version: number; body: string; blocks: DesignDocBlock[]; hash: string; created: string; author: string }
export interface DesignDoc { id: string; title: string; source: 'file' | 'db'; path?: string; order: number; status: DesignDocStatus; version: number; hash: string; body: string; blocks: DesignDocBlock[] }

/** Intake output belongs to the order's worker tree when it exists. */
export function intakeOutputDir(project: ProjectConfig, orders: Orders, tag: string): string {
  const doc = orders.get(tag);
  return doc.order.worktree && existsSync(doc.order.worktree) ? doc.order.worktree : project.root;
}

export function intakeOutputAlbaDir(project: ProjectConfig, orders: Orders, tag: string): string {
  return path.join(intakeOutputDir(project, orders, tag), '.alba');
}

/** Write the worker's immutable document/block index at run start. */
export function writeIntakeBlocksSnapshot(project: ProjectConfig, orders: Orders, tag: string, worktree: string): void {
  const created = orders.store.events({ tag }).findLast(event => event.type === 'intake-created');
  const selected = Array.isArray(created?.data?.documents) ? new Set((created!.data!.documents as unknown[]).map(value => String(value).split('@')[0])) : undefined;
  const docs = listDesignDocs(project).filter(doc => doc.status !== 'retired' && (!selected || selected.has(doc.id))).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  excludeLocally(worktree, ['.alba/intake/']);
  const dir = path.join(worktree, '.alba', 'intake');
  mkdirSync(dir, { recursive: true });
  const blocks = docs.flatMap(doc => doc.blocks.map((block, index) => ({
    doc: doc.id, version: doc.version, order: doc.order, status: doc.status, sequence: index + 1,
    ref: `${doc.id}@${doc.version}#${block.id}`, heading_path: block.heading_path, title_path: block.heading_path.join(' > '), text: block.text,
  })));
  writeFileSync(path.join(dir, 'blocks.json'), stableJson({ version: 1, documents: docs.map(doc => ({ id: doc.id, title: doc.title, version: doc.version, order: doc.order, status: doc.status })), blocks }), 'utf8');
}

function storeOf(project: ProjectConfig): SqliteStore {
  if (backendName(project) !== 'sqlite') throw new DesignError('Design documents require SQLite state. Run alba state migrate and set state: { backend: sqlite }.');
  const store = stateStore(project) as SqliteStore; store.ensureDesignDocsSchema(); return store;
}
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function normalized(value: string): string { return value.replace(/\r\n?/g, '\n').trim().split('\n').map(line => line.trim().replace(/\s+/g, ' ')).join('\n'); }

/** Split Markdown on headings and paragraphs while keeping the heading path in every block. */
export function chunkMarkdown(body: string): DesignDocBlock[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n'), headings: string[] = [], levels: number[] = [], blocks: DesignDocBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join('\n').trim(); paragraph = [];
    if (!text) return;
    const headingPath = [...headings];
    const base = `b${sha(`${headingPath.join(' > ')}\n${normalized(text)}`).slice(0, 12)}`;
    const used = new Set(blocks.map(block => block.id));
    let id = base, n = 2; while (used.has(id)) id = `${base}-${n++}`;
    blocks.push({ id, heading_path: headingPath, text, level: levels.at(-1) ?? 0 });
  };
  for (const line of lines) {
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush(); const level = match[1].length; while (headings.length >= level) { headings.pop(); levels.pop(); }
      headings.push(match[2].trim()); levels.push(level); continue;
    }
    if (!line.trim()) flush(); else paragraph.push(line);
  }
  flush();
  if (!blocks.length && body.trim()) blocks.push({ id: `b${sha(normalized(body)).slice(0, 12)}`, heading_path: [], text: body.trim(), level: 0 });
  return blocks;
}
function entryPath(project: ProjectConfig, entry: DesignDocEntry): string {
  const target = path.resolve(project.root, entry.path ?? '');
  const rel = path.relative(path.resolve(project.root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new DesignError(`Design document ${entry.id} is outside the project.`);
  return target;
}
function fileTitle(entry: DesignDocEntry, body: string): string {
  return entry.title ?? /^\s*#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() ?? entry.id;
}
function rows(store: SqliteStore): DesignDoc[] {
  const docs = store.db.prepare('SELECT id, title, source, path, doc_order, status FROM design_docs ORDER BY doc_order, id').all();
  return docs.map(row => {
    const latest = store.db.prepare('SELECT doc_id, version, body, blocks, hash, created, author FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(row.id);
    if (!latest) throw new DesignError(`Design document ${row.id} has no version.`);
    return { id: String(row.id), title: String(row.title), source: row.source as 'file' | 'db', ...(row.path ? { path: String(row.path) } : {}), order: Number(row.doc_order), status: row.status as DesignDocStatus, version: Number(latest.version), body: String(latest.body), blocks: JSON.parse(String(latest.blocks)) as DesignDocBlock[], hash: String(latest.hash) };
  });
}

function syncFiles(project: ProjectConfig, now = new Date().toISOString()): void {
  const config = project.design_docs?.files ?? [];
  if (!config.length) return;
  const store = storeOf(project);
  store.transaction(() => {
    for (const entry of config) {
      const file = entryPath(project, entry);
      if (!existsSync(file)) throw new DesignError(`Design document file does not exist: ${entry.path}`);
      const body = readFileSync(file, 'utf8'), hash = sha(body), blocks = chunkMarkdown(body);
      const existing = store.db.prepare('SELECT id FROM design_docs WHERE id = ?').get(entry.id);
      if (!existing) store.db.prepare('INSERT INTO design_docs(id, title, source, path, doc_order, status) VALUES (?, ?, \'file\', ?, ?, ?)').run(entry.id, fileTitle(entry, body), file, entry.order, entry.status);
      else store.db.prepare('UPDATE design_docs SET title = ?, path = ?, doc_order = ?, status = ?, source = \'file\' WHERE id = ?').run(fileTitle(entry, body), file, entry.order, entry.status, entry.id);
      const have = store.db.prepare('SELECT hash FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(entry.id);
      if (!have || have.hash !== hash) {
        const next = Number((store.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM design_doc_versions WHERE doc_id = ?').get(entry.id) as { v?: number } | undefined)?.v ?? 0) + 1;
        store.db.prepare('INSERT INTO design_doc_versions(doc_id, version, body, blocks, hash, created, author) VALUES (?, ?, ?, ?, ?, ?, ?)').run(entry.id, next, body, JSON.stringify(blocks), hash, now, 'file');
      }
    }
  });
}

export function listDesignDocs(project: ProjectConfig): DesignDoc[] { syncFiles(project); return rows(storeOf(project)); }
/** Read the stored document records without synchronizing file-backed sources. */
export function listDesignDocsReadOnly(project: ProjectConfig): DesignDoc[] { return rows(storeOf(project)); }
export function getDesignDoc(project: ProjectConfig, id: string, version?: number): DesignDoc {
  syncFiles(project); const store = storeOf(project), doc = store.db.prepare('SELECT id, title, source, path, doc_order, status FROM design_docs WHERE id = ?').get(id);
  if (!doc) throw new DesignError(`No design document ${id}.`, 404);
  const v = version === undefined ? store.db.prepare('SELECT * FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(id) : store.db.prepare('SELECT * FROM design_doc_versions WHERE doc_id = ? AND version = ?').get(id, version);
  if (!v) throw new DesignError(`No version ${version ?? ''} for design document ${id}.`, 404);
  return { id: String(doc.id), title: String(doc.title), source: doc.source as 'file' | 'db', ...(doc.path ? { path: String(doc.path) } : {}), order: Number(doc.doc_order), status: doc.status as DesignDocStatus, version: Number(v.version), body: String(v.body), blocks: JSON.parse(String(v.blocks)) as DesignDocBlock[], hash: String(v.hash) };
}
export function getDesignDocReadOnly(project: ProjectConfig, id: string, version?: number): DesignDoc {
  const store = storeOf(project), doc = store.db.prepare('SELECT id, title, source, path, doc_order, status FROM design_docs WHERE id = ?').get(id);
  if (!doc) throw new DesignError(`No design document ${id}.`, 404);
  const v = version === undefined ? store.db.prepare('SELECT * FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(id) : store.db.prepare('SELECT * FROM design_doc_versions WHERE doc_id = ? AND version = ?').get(id, version);
  if (!v) throw new DesignError(`No version ${version ?? ''} for design document ${id}.`, 404);
  return { id: String(doc.id), title: String(doc.title), source: doc.source as 'file' | 'db', ...(doc.path ? { path: String(doc.path) } : {}), order: Number(doc.doc_order), status: doc.status as DesignDocStatus, version: Number(v.version), body: String(v.body), blocks: JSON.parse(String(v.blocks)) as DesignDocBlock[], hash: String(v.hash) };
}
export function resolveDocRef(project: ProjectConfig, ref: string): { doc: DesignDoc; block: DesignDocBlock } {
  const match = /^([^@#]+)@(\d+)#(.+)$/.exec(ref); if (!match) throw new DesignError(`Invalid document reference ${ref}.`);
  const doc = getDesignDoc(project, match[1], Number(match[2])), block = doc.blocks.find(b => b.id === match[3]);
  if (!block) throw new DesignError(`No block ${match[3]} in ${match[1]}@${match[2]}.`, 404);
  return { doc, block };
}
export function resolveDocRefReadOnly(project: ProjectConfig, ref: string): { doc: DesignDoc; block: DesignDocBlock } {
  const match = /^([^@#]+)@(\d+)#(.+)$/.exec(ref); if (!match) throw new DesignError(`Invalid document reference ${ref}.`);
  const doc = getDesignDocReadOnly(project, match[1], Number(match[2])), block = doc.blocks.find(b => b.id === match[3]);
  if (!block) throw new DesignError(`No block ${match[3]} in ${match[1]}@${match[2]}.`, 404);
  return { doc, block };
}
export function importDesignDoc(project: ProjectConfig, file: string, id?: string, author = 'cli'): DesignDoc {
  syncFiles(project);
  const store = storeOf(project), absolute = path.resolve(file), body = readFileSync(absolute, 'utf8'), docId = id ?? path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_.-]+/g, '-');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(docId)) throw new DesignError(`Invalid design document id ${docId}.`);
  return store.transaction(() => {
    const prior = store.db.prepare('SELECT source FROM design_docs WHERE id = ?').get(docId);
    if (prior?.source === 'file') throw new DesignError(`Design document ${docId} is file-backed and cannot be edited in the database.`, 409);
    if (!prior) store.db.prepare('INSERT INTO design_docs(id, title, source, path, doc_order, status) VALUES (?, ?, \'db\', NULL, ?, \'draft\')').run(docId, fileTitle({ id: docId, path: file, order: 0, status: 'draft' }, body), 0);
    const hash = sha(body), latest = store.db.prepare('SELECT hash, version FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(docId);
    if (!latest || latest.hash !== hash) {
      const version = Number(latest?.version ?? 0) + 1;
      store.db.prepare('INSERT INTO design_doc_versions(doc_id, version, body, blocks, hash, created, author) VALUES (?, ?, ?, ?, ?, ?, ?)').run(docId, version, body, JSON.stringify(chunkMarkdown(body)), hash, new Date().toISOString(), author);
    }
    return getDesignDoc(project, docId);
  });
}
export function saveDesignDoc(project: ProjectConfig, input: { id: string; title?: string; body: string; author?: string }): DesignDoc {
  syncFiles(project);
  const store = storeOf(project); if (!input.id || !input.body.trim()) throw new DesignError('A design document needs an id and body.');
  return store.transaction(() => {
    const prior = store.db.prepare('SELECT source, title, doc_order, status FROM design_docs WHERE id = ?').get(input.id);
    if (prior?.source === 'file') throw new DesignError(`Design document ${input.id} is file-backed and cannot be edited in the database.`, 409);
    if (!prior) store.db.prepare('INSERT INTO design_docs(id, title, source, path, doc_order, status) VALUES (?, ?, \'db\', NULL, (SELECT COALESCE(MAX(doc_order), -1) + 1 FROM design_docs), \'draft\')').run(input.id, input.title?.trim() || fileTitle({ id: input.id, order: 0, status: 'draft' }, input.body));
    else if (input.title?.trim()) store.db.prepare('UPDATE design_docs SET title = ? WHERE id = ?').run(input.title.trim(), input.id);
    const body = input.body.replace(/\r\n?/g, '\n'), hash = sha(body), latest = store.db.prepare('SELECT hash, version FROM design_doc_versions WHERE doc_id = ? ORDER BY version DESC LIMIT 1').get(input.id);
    if (!latest || latest.hash !== hash) store.db.prepare('INSERT INTO design_doc_versions(doc_id, version, body, blocks, hash, created, author) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.id, Number(latest?.version ?? 0) + 1, body, JSON.stringify(chunkMarkdown(body)), hash, new Date().toISOString(), input.author ?? 'web');
    return getDesignDoc(project, input.id);
  });
}
export function exportDesignDoc(project: ProjectConfig, id: string, out: string): string { const doc = getDesignDoc(project, id); const target = path.resolve(out); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, doc.body, 'utf8'); return target; }
export function setDesignDoc(project: ProjectConfig, id: string, order: number, status: DesignDocStatus): DesignDoc {
  const store = storeOf(project); if (!Number.isSafeInteger(order) || !['approved', 'draft', 'retired'].includes(status)) throw new DesignError('Document order or status is invalid.');
  return store.transaction(() => { const row = store.db.prepare('SELECT source FROM design_docs WHERE id = ?').get(id); if (!row) throw new DesignError(`No design document ${id}.`, 404); if (row.source === 'file') throw new DesignError(`Document ${id} is file-backed; change its alba.yaml entry.`, 409); store.db.prepare('UPDATE design_docs SET doc_order = ?, status = ? WHERE id = ?').run(order, status, id); return getDesignDoc(project, id); });
}

export interface IntakeCheckIssue { code: string; message: string; file?: string }
export interface IntakeCheckResult { ok: boolean; issues: IntakeCheckIssue[]; changesets: string[]; blocks: number; classified: number }
export type IntakeSystemStatus = 'pending' | 'accepted' | 'rejected' | 'dropped';
export interface IntakeBlockDetail { ref: string; classification: string; entities?: { id: string; kind: string; title?: string; text?: string }[]; superseded?: { ref: string; text: string }; reason?: string; gap?: string; question?: string }
export function intakeReview(project: ProjectConfig, orders: Orders, tag: string): { order: string; docs: DesignDoc[]; coverage: Record<string, unknown>; questions: string; systems: { id: string; status: IntakeSystemStatus; note?: string; entities: number; target_count: number }[]; blocks: IntakeBlockDetail[]; latestCheck?: unknown; intake_check?: unknown } {
  const output = intakeOutputDir(project, orders, tag), root = path.join(output, '.alba'), coveragePath = path.join(root, 'intake', 'coverage.json'), questionsPath = path.join(root, 'intake', 'questions.md');
  let raw: any = {}; try { raw = JSON.parse(readFileSync(coveragePath, 'utf8')); } catch { /* page shows an empty coverage state */ }
  const coverage: Record<string, unknown> = Array.isArray(raw.blocks) ? Object.fromEntries(raw.blocks.map((entry: any) => [entry.ref, entry])) : (raw.blocks ?? {});
  const questions = (() => { try { return readFileSync(questionsPath, 'utf8'); } catch { return ''; } })();
  const events = orders.store.events({ tag }), statuses = new Map<string, { status: IntakeSystemStatus; note?: string }>();
  for (const event of events) {
    if (event.type === 'run-start') for (const [system, state] of statuses) if (state.status === 'rejected') statuses.delete(system);
    if (['intake-system-accepted', 'intake-system-rejected', 'intake-system-dropped'].includes(event.type) && typeof event.data?.system === 'string') statuses.set(String(event.data.system), { status: event.type.endsWith('accepted') ? 'accepted' : event.type.endsWith('dropped') ? 'dropped' : 'rejected', ...(typeof event.data?.note === 'string' ? { note: event.data.note } : {}) });
  }
  const changesDir = path.join(root, 'design', 'changes'), systems = existsSync(changesDir) ? readdirSync(changesDir).filter(file => /^intake-.+\.json$/i.test(file)).map(file => file.replace(/^intake-/i, '').replace(/\.json$/i, '')) : [];
  const sets = new Map<string, any>(); for (const id of systems) try { sets.set(id, readChangeSet(path.join(changesDir, `intake-${id}.json`)) as any); } catch { /* check reports malformed files */ }
  const blocks: IntakeBlockDetail[] = [];
  for (const doc of listDesignDocs(project).filter(d => d.status !== 'retired')) for (const block of doc.blocks) {
    const ref = `${doc.id}@${doc.version}#${block.id}`, entry = coverage[ref] as any, detail: IntakeBlockDetail = { ref, classification: entry ? ['mapped', 'superseded', 'out-of-scope', 'unclear'].find(key => key in entry) ?? 'pending' : 'pending' };
    if (entry?.mapped) {
      const ids = Array.isArray(entry.mapped) ? entry.mapped : entry.mapped.entities;
      detail.entities = (ids ?? []).map((id: string) => { for (const set of sets.values()) { const c = set.changes?.find((change: any) => change.id === id); if (c) return { id, kind: c.kind, title: c.fields?.name ?? c.fields?.title, text: c.fields?.text ?? c.fields?.summary }; } return { id, kind: 'entity' }; });
    }
    if (typeof entry?.superseded === 'string') { try { const replacement = resolveDocRef(project, entry.superseded); detail.superseded = { ref: entry.superseded, text: replacement.block.text }; } catch { detail.superseded = { ref: entry.superseded, text: '' }; } }
    if (typeof entry?.['out-of-scope'] === 'string') detail.reason = entry['out-of-scope'];
    if (typeof entry?.unclear === 'string') { detail.gap = entry.unclear; const line = questions.split(/\r?\n/).find(line => line.includes(entry.unclear)); if (line) detail.question = line.replace(/^\s*[-*]\s*/, ''); }
    blocks.push(detail);
  }
  const latestCheck = events.filter(event => event.type === 'accept-step' && event.data?.name === 'intake-check').at(-1)?.data;
  return { order: tag, docs: listDesignDocs(project), coverage, questions, systems: systems.map(id => { const set = sets.get(id); return { id, ...(statuses.get(id) ?? { status: 'pending' }), entities: Array.isArray(set?.changes) ? set.changes.filter((change: any) => change.kind !== 'target').length : 0, target_count: Array.isArray(set?.changes) ? set.changes.filter((change: any) => change.kind === 'target').length : 0 }; }), blocks, ...(latestCheck ? { latestCheck, intake_check: latestCheck } : {}) };
}
export function checkIntake(project: ProjectConfig, orders: Orders, dir?: string, documentsProject: ProjectConfig = project): IntakeCheckResult {
  if (!dir) {
    const intake = orders.all().filter(doc => doc.order.kind === 'intake' && doc.order.worktree && existsSync(doc.order.worktree)).at(-1);
    dir = intake ? intakeOutputAlbaDir(project, orders, intake.order.tag) : path.join(project.root, '.alba');
  }
  const issues: IntakeCheckIssue[] = [], changesDir = path.join(dir, 'design', 'changes');
  const changeFiles = existsSync(changesDir) ? readdirSync(changesDir).filter(name => name.endsWith('.json')).sort() : [] as string[];
  for (const name of changeFiles) { try { const result = applyChangeSet(project, orders, readChangeSet(path.join(changesDir, name)), { dryRun: true, idempotent: true }); if (result.warnings.some(w => w.severity === 'error')) issues.push({ code: 'changeset-invalid', file: name, message: result.warnings.map(w => w.message).join('; ') }); } catch (e) { issues.push({ code: 'changeset-invalid', file: name, message: (e as Error).message }); } }
  const coverageFile = path.join(dir, 'intake', 'coverage.json');
  let coverage: any = undefined; try { coverage = JSON.parse(readFileSync(coverageFile, 'utf8')); } catch (e) { issues.push({ code: 'coverage-missing', message: `Cannot read coverage.json: ${(e as Error).message}` }); }
  const blocks = (documentsProject === project ? listDesignDocs(project) : listDesignDocsReadOnly(documentsProject)).filter(d => d.status !== 'retired').flatMap(d => d.blocks.map(block => ({ ref: `${d.id}@${d.version}#${block.id}`, doc: d })));
  const entries: any[] = Array.isArray(coverage?.blocks) ? coverage.blocks : coverage && typeof coverage.blocks === 'object' ? Object.entries(coverage.blocks).map(([ref, value]) => ({ ref, ...(value as object) })) : [];
  const byRef = new Map(entries.map((entry: any) => [entry.ref, entry]));
  for (const entry of entries) if (!blocks.some(block => block.ref === entry.ref)) issues.push({ code: 'coverage-ref', message: `Coverage references unknown block ${String(entry.ref)}.` });
  const library = readLibrary(project), entities = new Set(DESIGN_KINDS.flatMap(kind => library[kind].map(row => entityId(kind, row) as string)));
  const decisions = new Set(documentsProject.decisions ? readLedger(documentsProject.decisions).map(d => d.id) : []);
  const resolveSource = documentsProject === project ? resolveDocRef : resolveDocRefReadOnly;
  for (const name of changeFiles) { try { const set = readChangeSet(path.join(changesDir, name)) as any; for (const change of set.changes) {
      entities.add(String(change.id));
      if (change.kind === 'rule') {
        if (!Array.isArray(change.fields?.sources) || !change.fields.sources.length) issues.push({ code: 'rule-sources', file: name, message: `${change.id} must declare at least one source.` });
        else for (const source of change.fields.sources) {
          if (source?.kind === 'doc') { try { resolveSource(documentsProject, String(source.ref)); } catch (error) { issues.push({ code: 'source-unresolved', file: name, message: `${change.id}: ${(error as Error).message}` }); } }
          else if (source?.kind === 'decision') { if (!decisions.has(String(source.ref))) issues.push({ code: 'source-unresolved', file: name, message: `${change.id}: decision ${String(source.ref)} cannot be resolved.` }); }
          else issues.push({ code: 'source-unresolved', file: name, message: `${change.id}: source kind is not doc or decision.` });
        }
      }
    } } catch { /* reported above */ } }
  const gapIds = new Set(changeFiles.flatMap(name => { try { const set = readChangeSet(path.join(changesDir, name)) as any; return set.changes.filter((c: any) => c.kind === 'gap').map((c: any) => c.id); } catch { return []; } }));
  for (const block of blocks) {
    const entry = byRef.get(block.ref);
    if (!entry) { issues.push({ code: 'unclassified-block', message: `Block ${block.ref} has no coverage classification.` }); continue; }
    const kinds = ['mapped', 'superseded', 'out-of-scope', 'unclear'].filter(kind => entry[kind] !== undefined);
    if (kinds.length !== 1) issues.push({ code: 'coverage-classification', message: `Block ${block.ref} must have exactly one classification.` });
    if (entry.mapped !== undefined) {
      const ids = Array.isArray(entry.mapped) ? entry.mapped : entry.mapped.entities;
      if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== 'string' || !id.trim())) issues.push({ code: 'coverage-entity', message: `Block ${block.ref} has invalid mapped entities.` });
      else for (const id of ids) if (!entities.has(id) && !decisions.has(id)) issues.push({ code: 'coverage-entity', message: `Block ${block.ref} maps to unknown entity ${id}.` });
    }
    if (entry.superseded !== undefined) { try { const replacement = resolveSource(documentsProject, String(entry.superseded)); if (replacement.doc.id === block.doc.id || replacement.doc.order <= block.doc.order) issues.push({ code: 'coverage-order', message: `Block ${block.ref} is superseded by a block from the same or earlier document.` }); } catch (e) { issues.push({ code: 'coverage-ref', message: (e as Error).message }); } }
    if (entry.unclear !== undefined && (typeof entry.unclear !== 'string' || !gapIds.has(entry.unclear))) issues.push({ code: 'coverage-gap', message: `Block ${block.ref} must name an existing gap.` });
  }
  const questionFile = path.join(dir, 'intake', 'questions.md');
  let questions = ''; try { questions = readFileSync(questionFile, 'utf8'); } catch { issues.push({ code: 'questions-missing', message: 'questions.md is missing.' }); }
  for (const entry of entries) if (typeof entry.unclear === 'string' && !questions.includes(entry.unclear)) issues.push({ code: 'coverage-gap', message: `questions.md does not mention ${entry.unclear}.` });
  const gapPattern = /\b[A-Z][A-Z0-9]*-G\d+\b/g;
  for (const line of questions.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s*[-*+]\s+/.test(line)) { if (gapPattern.test(line) || /\?/.test(line)) issues.push({ code: 'question-format', message: 'Each intake question must be a list item.' }); gapPattern.lastIndex = 0; continue; }
    const refs = line.match(gapPattern) ?? [];
    if (!refs.length) issues.push({ code: 'question-gap', message: `Question has no gap id: ${line.trim()}` });
    for (const ref of refs) if (!gapIds.has(ref)) issues.push({ code: 'question-gap', message: `questions.md references unknown gap ${ref}.` });
  }
  for (const entry of entries) if (typeof entry.unclear === 'string' && !questions.split(/\r?\n/).some(line => line.includes(entry.unclear) && /^\s*[-*+]\s+/.test(line))) issues.push({ code: 'question-gap', message: `Question for ${entry.unclear} must be a list item.` });
  const min = project.intake?.min_targets_per_system ?? project.design?.min_targets_per_system ?? 3;
  for (const name of changeFiles) { try { const set = readChangeSet(path.join(changesDir, name)) as any; const counts = new Map<string, number>(), systems = new Set<string>(); for (const c of set.changes) { if (c.kind === 'system') systems.add(String(c.id)); if (c.kind === 'target') counts.set(String(c.fields.system), (counts.get(String(c.fields.system)) ?? 0) + 1); } for (const system of systems) if ((counts.get(system) ?? 0) < min) issues.push({ code: 'few-targets', file: name, message: `${system} has ${counts.get(system) ?? 0} targets; minimum is ${min}.` }); } catch { /* reported above */ } }
  return { ok: issues.length === 0, issues, changesets: changeFiles, blocks: blocks.length, classified: blocks.filter(block => byRef.has(block.ref)).length };
}
