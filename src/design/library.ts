import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { backendName, stateStore } from '../orders/backend.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import type { Orders } from '../orders/service.ts';
import { JsonDataCache, resolveParam } from './files.ts';
import { DESIGN_KINDS, DESIGN_OFF, DesignError, emptyLibrary, entityId, type Library, type History, type DesignKind, type Entity, type Issue } from './model.ts';
import { nextEntity, normalizeDecisions, parseChangeSet, validateLibrary } from './validate.ts';

export function requireDesign(project: ProjectConfig): SqliteStore {
  if (!project.design?.enabled) throw new DesignError(DESIGN_OFF, 404);
  if (backendName(project) !== 'sqlite') throw new DesignError('Design library requires SQLite state. Run alba state migrate and set state: { backend: sqlite }.');
  return stateStore(project) as SqliteStore;
}
export function readLibrary(project: ProjectConfig): Library {
  const store = requireDesign(project), library = emptyLibrary();
  // A single SQL statement provides one consistent read across every table.
  const rows = store.db.prepare(DESIGN_KINDS.map(kind => `SELECT '${kind}' AS kind, id, document FROM design_${kind}`).join(' UNION ALL ') + ' ORDER BY kind, id').all();
  for (const row of rows) (library[row.kind as DesignKind] as Entity[]).push(JSON.parse(row.document as string) as Entity);
  return library;
}
export function designHistory(project: ProjectConfig, id?: string): History[] {
  const store = requireDesign(project);
  const rows = id === undefined ? store.db.prepare('SELECT * FROM design_history ORDER BY id').all() : store.db.prepare('SELECT * FROM design_history WHERE entity = ? ORDER BY id').all(id);
  return rows.map(r => ({ id: Number(r.id), at: String(r.at), kind: r.kind as DesignKind, entity: String(r.entity), op: r.op as History['op'], before: r.before === null ? null : JSON.parse(r.before as string), after: JSON.parse(r.after as string), by: r.by_actor as History['by'], order: r.order_tag as string | null, decision: r.decision as string | null, changeset: String(r.changeset) }));
}
/** Canonical object keys and table ordering make exports byte stable for unchanged input. */
export function stableJson(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, sorted(child)])) : v;
  return JSON.stringify(sorted(value), null, 2) + '\n';
}
export function resolvedValues(project: ProjectConfig, library = readLibrary(project), cache = new JsonDataCache()): { id: string; value?: unknown; error?: string }[] {
  return library.param.map(p => { try { return { id: p.id, value: resolveParam(project.root, p, cache) }; } catch (e) { return { id: p.id, error: (e as Error).message }; } });
}
export function librarySnapshot(project: ProjectConfig, cache = new JsonDataCache()): Library & { resolved_values: ReturnType<typeof resolvedValues> } {
  const library = readLibrary(project);
  return { ...library, resolved_values: resolvedValues(project, library, cache) };
}
export function exportDesign(project: ProjectConfig, out: string, cache = new JsonDataCache()): string {
  const store = requireDesign(project);
  const data = store.transaction(() => ({ ...librarySnapshot(project, cache), history: designHistory(project) }));
  mkdirSync(out, { recursive: true });
  for (const [table, rows] of Object.entries(data)) {
    const file = path.join(out, `${table}.json`), temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, stableJson(rows), 'utf8'); renameSync(temp, file);
  }
  return out;
}
function backup(project: ProjectConfig, cache: JsonDataCache): string {
  const root = project.design!.export_dir;
  mkdirSync(root, { recursive: true });
  const id = designHistory(project).at(-1)!.id.toString().padStart(12, '0');
  const pending = path.join(root, `.pending-${randomUUID()}`), out = path.join(root, `${id}-${randomUUID()}`);
  exportDesign(project, pending, cache); renameSync(pending, out);
  const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d{12}-[\da-f-]+$/.test(d.name)).map(d => d.name).sort();
  for (const dir of dirs.slice(0, -30)) {
    const target = path.resolve(root, dir), relative = path.relative(path.resolve(root), target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new DesignError('Export retention path escapes its directory.');
    rmSync(target, { recursive: true });
  }
  return out;
}
export interface ApplyOptions { dryRun?: boolean; by?: History['by']; order?: string; idempotent?: boolean }
export interface ApplyResult { applied: boolean; dryRun: boolean; changeset: string; changes: number; warnings: Issue[]; export?: string; export_error?: string; alreadyApplied?: boolean }
const contentHash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
/** Match the content hash of the canonical change set. */
export function appliedChangeSet(raw: unknown, history: History[]): boolean {
  const set = parseChangeSet(raw), hashes = new Set(history.map(h => h.changeset));
  return hashes.has(contentHash(set));
}
export function applyChangeSet(project: ProjectConfig, orders: Orders, raw: unknown, options: ApplyOptions = {}): ApplyResult {
  return applyChangeSets(project, orders, [raw], options)[0];
}
/** One delivery is one transaction; retain each file's hash and attribution for safe retries. */
export function applyChangeSets(project: ProjectConfig, orders: Orders, raw: unknown[], options: ApplyOptions = {}): ApplyResult[] {
  const store = requireDesign(project), cache = new JsonDataCache();
  const sets = raw.map(value => {
    const set = parseChangeSet(value);
    const key = contentHash(set);
    if (options.order) set.order = options.order;
    return { set, key, raw: value };
  });
  const by = options.by ?? 'cli', at = new Date().toISOString();
  const results = store.transaction((): ApplyResult[] => {
    const next = readLibrary(project);
    for (const { set } of sets) normalizeDecisions(project, set, next, orders);
    const seen = new Set<string>();
    const history = designHistory(project), included = new Set<string>();
    const pending = sets.filter(({ key, raw }) => {
      if (options.idempotent && (included.has(key) || appliedChangeSet(raw, history))) return false;
      included.add(key); return true;
    });
    const batches = pending.map(({ set, key }) => {
      const changes = set.changes.map(change => {
        const identity = `${change.kind}:${change.id}`;
        if (seen.has(identity)) throw new DesignError(`Duplicate entity across change sets: ${identity}`);
        seen.add(identity);
        const rows = next[change.kind] as Entity[], index = rows.findIndex(r => entityId(change.kind, r) === change.id), before = rows[index];
        if (change.op === 'create' && before) throw new DesignError(`${change.kind}:${change.id} already exists (version ${before.version}); ids are never reused.`, 409);
        if (change.op !== 'create' && !before) throw new DesignError(`${change.kind}:${change.id} does not exist.`, 404);
        if (before && change.base_version !== before.version) throw new DesignError(`Conflict on ${change.kind}:${change.id}: base_version ${change.base_version}, current version ${before.version}.`, 409);
        const after = nextEntity(change.kind, change.id, change.fields, before, at, change.op === 'retire');
        if (index < 0) rows.push(after); else rows[index] = after;
        return { kind: change.kind, id: change.id, before, after, op: change.op };
      });
      return { set, key, changes };
    });
    const warnings = pending.length ? validateLibrary(project, orders, next, pending.map(p => p.set), cache) : [];
    if (!options.dryRun) for (const { set, key, changes } of batches) for (const c of changes) {
      store.db.prepare(`INSERT INTO design_${c.kind}(id, document, version, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, version = excluded.version, updated = excluded.updated`).run(c.id, JSON.stringify(c.after), c.after.version, at);
      store.db.prepare('INSERT INTO design_history(at, kind, entity, op, before, after, by_actor, order_tag, decision, changeset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(at, c.kind, c.id, c.op, c.before ? JSON.stringify(c.before) : null, JSON.stringify(c.after), by, set.order ?? null, set.decision ?? null, key);
    }
    return sets.map(({ key }) => {
      const batch = batches.find(b => b.key === key);
      return batch ? { applied: !options.dryRun, dryRun: !!options.dryRun, changeset: key, changes: batch.changes.length, warnings: [...warnings] } : { applied: false, dryRun: !!options.dryRun, changeset: key, changes: 0, warnings: [], alreadyApplied: true };
    });
  });
  if (!options.dryRun && results.some(r => r.applied || r.alreadyApplied)) {
    try {
      const out = backup(project, cache);
      // Export already resolves unchanged params: surface its stale locations without refusing edits.
      const warnings: Issue[] = resolvedValues(project, undefined, cache).filter(v => v.error).map(v => ({ severity: 'warning', code: 'param-unresolved', entity: v.id, message: v.error! }));
      for (const result of results) { result.export = out; result.warnings.push(...warnings); }
    }
    catch (e) { for (const result of results) result.export_error = `Change set is committed; export failed: ${(e as Error).message}. Retry alba design export.`; }
  }
  return results;
}
export function readChangeSet(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
