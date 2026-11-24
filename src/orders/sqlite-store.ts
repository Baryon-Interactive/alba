import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { t } from '../i18n.ts';
import type { AttentionMark } from './attention-store.ts';
import type { OrderDoc, OrderEvent } from './model.ts';
import { StaleWrite, type OrderStore, revisionOf, withRevision, validateTag } from './store.ts';
import type { QuotaReading } from '../workers/quota.ts';

const HAS_BALANCE = "json_extract(reading, '$.ok') = 1 AND json_extract(reading, '$.balance.amount') IS NOT NULL";
export interface QuotaHistoryOptions { source?: string; limit?: number }

export interface ScheduleFireRow {
  schedule_id: string;
  planned_at: string;
  fired_at: string;
  status: 'created' | 'skipped';
  order_tag?: string;
  reason?: string;
  manual: boolean;
}

export interface ScheduleStateRow {
  schedule_id: string;
  paused: boolean;
  paused_at?: string;
  paused_reason?: string;
  auto_paused: boolean;
  resumed_at?: string;
  updated_at: string;
}

export interface IdempotencyReceiptRow {
  idempotency_key: string;
  instance_id?: string;
  method: string;
  route: string;
  body_hash: string;
  status: 'in_progress' | 'completed';
  status_code?: number;
  response_body?: string;
  created_at: string;
  updated_at: string;
}

/** SQLite keeps the schema version independent from the optimistic document version. */
export class SqliteStore implements OrderStore {
  readonly dir: string;
  readonly db: DatabaseSync;
  private depth = 0;
  private schedulesReady = false;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'state.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    // Reopening a current database must remain a reader: BEGIN IMMEDIATE (even for IF NOT EXISTS) waits on every writer.
    if (this.db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') this.db.exec('PRAGMA journal_mode=WAL');
    const schema = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    const version = schema ? this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version as number | null : undefined;
    if (version && version > 9) { this.db.close(); throw new Error(t('State schema {version} is newer than this program supports.', { version })); }
    if (version !== undefined && version !== null && version >= 6 && version <= 9) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const current = this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version as number | null;
      if (current && current > 9) throw new Error(t('State schema {version} is newer than this program supports.', { version: current }));
      if (!current) {
        this.db.exec(`
          CREATE TABLE orders (tag TEXT PRIMARY KEY, document TEXT NOT NULL, updated TEXT NOT NULL, version INTEGER NOT NULL);
          CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tag TEXT NOT NULL, type TEXT NOT NULL, by_actor TEXT, data TEXT);
          CREATE INDEX events_tag ON events(tag, id);
          CREATE INDEX events_at ON events(at);
          CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO schema_version VALUES (1);
        `);
      }
      if (!current || current < 2) {
        this.db.exec('CREATE UNIQUE INDEX orders_tag_case ON orders(tag COLLATE NOCASE); INSERT INTO schema_version VALUES (2);');
      }
      if (!current || current < 3) {
        this.db.exec(`
          CREATE TABLE quota_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, reading TEXT NOT NULL);
          CREATE INDEX quota_history_source_at ON quota_history(source, at);
          CREATE INDEX quota_history_source_id ON quota_history(source, id);
          CREATE INDEX quota_history_balance ON quota_history(source, id) WHERE ${HAS_BALANCE};
        `);
        // Upgrade databases written by schema 2 once, without retaining the growing metadata value.
        const history = this.readMeta('file:quota-history.jsonl') as string | undefined;
        for (const line of (history ?? '').split('\n').filter(Boolean)) this.appendQuotaReading(JSON.parse(line) as QuotaReading);
        this.db.prepare('DELETE FROM meta WHERE name = ?').run('file:quota-history.jsonl');
        this.db.exec('INSERT INTO schema_version VALUES (3)');
      }
      if (!current || current < 4) {
        this.db.exec(`CREATE TABLE usage (run TEXT NOT NULL, turn INTEGER NOT NULL, at TEXT NOT NULL, worker TEXT NOT NULL, order_tag TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY(run, turn));
          CREATE INDEX usage_at ON usage(at); CREATE INDEX usage_order ON usage(order_tag, at); CREATE INDEX usage_worker ON usage(worker, at);`);
        const old = this.db.prepare("SELECT value FROM meta WHERE name = 'usage'").get();
        if (old) { this.depth++; try { this.writeMeta('usage', JSON.parse(old.value as string)); } finally { this.depth--; } }
        this.db.exec('INSERT INTO schema_version VALUES (4)');
      }
      if (!current || current < 5) {
        for (const kind of ['system', 'rule', 'formula', 'param', 'target', 'gap', 'milestone', 'term', 'decision_link']) {
          this.db.exec(`CREATE TABLE design_${kind} (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)), version INTEGER NOT NULL CHECK(version > 0), updated TEXT NOT NULL)`);
        }
        this.db.exec(`CREATE TABLE design_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL, op TEXT NOT NULL CHECK(op IN ('create','update','retire')), before TEXT, after TEXT NOT NULL, by_actor TEXT NOT NULL CHECK(by_actor IN ('web','cli','accept')), order_tag TEXT, decision TEXT, changeset TEXT NOT NULL);
          CREATE INDEX design_history_entity ON design_history(entity, id);
          CREATE INDEX design_history_changeset ON design_history(changeset);
          INSERT INTO schema_version VALUES (5)`);
      }
      if (!current || current < 6) {
        // SQLite cannot widen a CHECK in place. Preserve every immutable history id and its indexes.
        this.db.exec(`ALTER TABLE design_history RENAME TO design_history_v5;
          CREATE TABLE design_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL, op TEXT NOT NULL CHECK(op IN ('create','update','retire')), before TEXT, after TEXT NOT NULL, by_actor TEXT NOT NULL CHECK(by_actor IN ('web','cli','accept','measure')), order_tag TEXT, decision TEXT, changeset TEXT NOT NULL);
          INSERT INTO design_history SELECT * FROM design_history_v5;
          DROP TABLE design_history_v5;
          CREATE INDEX design_history_entity ON design_history(entity, id);
          CREATE INDEX design_history_changeset ON design_history(changeset);
          INSERT INTO schema_version VALUES (6)`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }

  /** Document intake is an optional module. Existing projects keep schema 6 until it is first used. */
  ensureDesignDocsSchema(): void {
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_docs'").get()) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS design_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('file','db')), path TEXT, doc_order INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('approved','draft','retired')));
        CREATE TABLE IF NOT EXISTS design_doc_versions (doc_id TEXT NOT NULL REFERENCES design_docs(id) ON DELETE CASCADE, version INTEGER NOT NULL, body TEXT NOT NULL, blocks TEXT NOT NULL CHECK(json_valid(blocks)), hash TEXT NOT NULL, created TEXT NOT NULL, author TEXT NOT NULL, PRIMARY KEY(doc_id, version));
        CREATE UNIQUE INDEX IF NOT EXISTS design_doc_versions_hash ON design_doc_versions(doc_id, hash);
        CREATE INDEX IF NOT EXISTS design_docs_order ON design_docs(doc_order, id);`);
      const current = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? 0);
      if (current < 7) this.db.exec('INSERT INTO schema_version VALUES (7)');
    });
  }

  private hasSchedulesTables(): boolean {
    if (this.schedulesReady) return true;
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_fires'").get();
    if (found) this.schedulesReady = true;
    return this.schedulesReady;
  }

  /** Schedules and API idempotency receipts share schema version 8; created lazily on first write so reads stay read-only. */
  ensureSchedulesSchema(): void {
    if (this.hasSchedulesTables()) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_fires (
          schedule_id TEXT NOT NULL,
          planned_at TEXT NOT NULL,
          fired_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('created','skipped')),
          order_tag TEXT,
          reason TEXT,
          manual INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(schedule_id, planned_at)
        );
        CREATE INDEX IF NOT EXISTS schedule_fires_schedule_at ON schedule_fires(schedule_id, planned_at DESC);
        CREATE TABLE IF NOT EXISTS schedule_state (
          schedule_id TEXT PRIMARY KEY,
          paused INTEGER NOT NULL DEFAULT 0,
          paused_at TEXT,
          paused_reason TEXT,
          auto_paused INTEGER NOT NULL DEFAULT 0,
          resumed_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idempotency_receipts (
          idempotency_key TEXT PRIMARY KEY,
          instance_id TEXT,
          method TEXT NOT NULL,
          route TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
          status_code INTEGER,
          response_body TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idempotency_receipts_created ON idempotency_receipts(created_at);`);
      const current = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? 0);
      if (current < 8) this.db.exec('INSERT INTO schema_version VALUES (8)');
    });
    this.schedulesReady = true;
  }

  private toScheduleFire(row: Record<string, unknown>): ScheduleFireRow {
    return {
      schedule_id: row.schedule_id as string,
      planned_at: row.planned_at as string,
      fired_at: row.fired_at as string,
      status: row.status as 'created' | 'skipped',
      ...(row.order_tag !== null ? { order_tag: row.order_tag as string } : {}),
      ...(row.reason !== null ? { reason: row.reason as string } : {}),
      manual: Number(row.manual) === 1,
    };
  }

  getScheduleFire(scheduleId: string, plannedAt: string): ScheduleFireRow | undefined {
    if (!this.hasSchedulesTables()) return undefined;
    const row = this.db.prepare('SELECT * FROM schedule_fires WHERE schedule_id = ? AND planned_at = ?').get(scheduleId, plannedAt);
    return row ? this.toScheduleFire(row) : undefined;
  }

  listScheduleFires(scheduleId?: string): ScheduleFireRow[] {
    if (!this.hasSchedulesTables()) return [];
    const rows = scheduleId !== undefined
      ? this.db.prepare('SELECT * FROM schedule_fires WHERE schedule_id = ? ORDER BY planned_at ASC, fired_at ASC').all(scheduleId)
      : this.db.prepare('SELECT * FROM schedule_fires ORDER BY planned_at ASC, fired_at ASC').all();
    return rows.map(r => this.toScheduleFire(r));
  }

  insertScheduleFire(fire: ScheduleFireRow): boolean {
    this.ensureSchedulesSchema();
    const res = this.db.prepare(
      'INSERT OR IGNORE INTO schedule_fires(schedule_id, planned_at, fired_at, status, order_tag, reason, manual) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(fire.schedule_id, fire.planned_at, fire.fired_at, fire.status, fire.order_tag ?? null, fire.reason ?? null, fire.manual ? 1 : 0);
    return Number(res.changes) > 0;
  }

  private toScheduleState(row: Record<string, unknown>): ScheduleStateRow {
    return {
      schedule_id: row.schedule_id as string,
      paused: Number(row.paused) === 1,
      ...(row.paused_at !== null ? { paused_at: row.paused_at as string } : {}),
      ...(row.paused_reason !== null ? { paused_reason: row.paused_reason as string } : {}),
      auto_paused: Number(row.auto_paused) === 1,
      ...(row.resumed_at !== null ? { resumed_at: row.resumed_at as string } : {}),
      updated_at: row.updated_at as string,
    };
  }

  getScheduleState(scheduleId: string): ScheduleStateRow | undefined {
    if (!this.hasSchedulesTables()) return undefined;
    const row = this.db.prepare('SELECT * FROM schedule_state WHERE schedule_id = ?').get(scheduleId);
    return row ? this.toScheduleState(row) : undefined;
  }

  allScheduleStates(): ScheduleStateRow[] {
    if (!this.hasSchedulesTables()) return [];
    return this.db.prepare('SELECT * FROM schedule_state ORDER BY schedule_id ASC').all().map(r => this.toScheduleState(r));
  }

  setScheduleState(state: ScheduleStateRow): void {
    this.ensureSchedulesSchema();
    this.db.prepare(
      `INSERT INTO schedule_state(schedule_id, paused, paused_at, paused_reason, auto_paused, resumed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(schedule_id) DO UPDATE SET
         paused = excluded.paused,
         paused_at = excluded.paused_at,
         paused_reason = excluded.paused_reason,
         auto_paused = excluded.auto_paused,
         resumed_at = excluded.resumed_at,
         updated_at = excluded.updated_at`
    ).run(state.schedule_id, state.paused ? 1 : 0, state.paused_at ?? null, state.paused_reason ?? null, state.auto_paused ? 1 : 0, state.resumed_at ?? null, state.updated_at);
  }

  private toIdempotencyReceipt(row: Record<string, unknown>): IdempotencyReceiptRow {
    return {
      ...(typeof row.instance_id === 'string' && { instance_id: row.instance_id }),
      idempotency_key: row.idempotency_key as string,
      method: row.method as string,
      route: row.route as string,
      body_hash: row.body_hash as string,
      status: row.status as 'in_progress' | 'completed',
      ...(row.status_code !== null ? { status_code: Number(row.status_code) } : {}),
      ...(row.response_body !== null ? { response_body: row.response_body as string } : {}),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  getIdempotencyReceipt(key: string): IdempotencyReceiptRow | undefined {
    if (!this.hasSchedulesTables()) return undefined;
    const row = this.db.prepare('SELECT * FROM idempotency_receipts WHERE idempotency_key = ?').get(key);
    return row ? this.toIdempotencyReceipt(row) : undefined;
  }

  private ensureReceiptOwnerColumn(): void {
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('idempotency_receipts') WHERE name = 'instance_id'").get()) {
      this.db.exec('ALTER TABLE idempotency_receipts ADD COLUMN instance_id TEXT');
    }
  }

  clearForeignClaims(instanceId: string): void {
    if (!this.hasSchedulesTables()) return;
    this.ensureReceiptOwnerColumn();
    this.db.prepare("DELETE FROM idempotency_receipts WHERE status = 'in_progress' AND instance_id IS NOT ?").run(instanceId);
  }

  purgeExpiredIdempotencyReceipts(cutoffIso: string): number {
    if (!this.hasSchedulesTables()) return 0;
    const res = this.db.prepare('DELETE FROM idempotency_receipts WHERE created_at < ?').run(cutoffIso);
    return Number(res.changes);
  }

  insertIdempotencyReceipt(receipt: IdempotencyReceiptRow): boolean {
    this.ensureSchedulesSchema();
    this.ensureReceiptOwnerColumn();
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO idempotency_receipts(idempotency_key, method, route, body_hash, status, status_code, response_body, created_at, updated_at, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(receipt.idempotency_key, receipt.method, receipt.route, receipt.body_hash, receipt.status, receipt.status_code ?? null, receipt.response_body ?? null, receipt.created_at, receipt.updated_at, receipt.instance_id ?? null);
    return Number(res.changes) > 0;
  }

  completeIdempotencyReceipt(key: string, statusCode: number, responseBody: string, updatedAt: string): void {
    this.ensureSchedulesSchema();
    this.db.prepare(
      `UPDATE idempotency_receipts SET status = 'completed', status_code = ?, response_body = ?, updated_at = ? WHERE idempotency_key = ?`
    ).run(statusCode, responseBody, updatedAt, key);
  }

  deleteIdempotencyReceipt(key: string): void {
    if (!this.hasSchedulesTables()) return;
    this.db.prepare('DELETE FROM idempotency_receipts WHERE idempotency_key = ?').run(key);
  }

  ensureAttentionSchema(): void {
    if (this.hasAttentionSchema()) return;
    this.transaction(() => {
      if (this.hasAttentionSchema()) return;
      this.ensureDesignDocsSchema();
      this.db.exec(`CREATE TABLE order_attention (tag TEXT PRIMARY KEY, seen_at TEXT, muted INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO meta(name, value) VALUES ('order-attention', '[]');
        INSERT INTO schema_version SELECT 9 WHERE COALESCE((SELECT MAX(version) FROM schema_version), 0) < 9`);
    });
  }

  attentionRows(): AttentionMark[] {
    if (!this.hasAttentionSchema()) return [];
    return this.db.prepare('SELECT tag, seen_at, muted FROM order_attention ORDER BY rowid').all()
      .map(row => ({ tag: String(row.tag), muted: !!row.muted, ...(typeof row.seen_at === 'string' && { seen_at: row.seen_at }) }));
  }

  private hasAttentionSchema(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'order_attention'").get();
  }

  counts(): { orders: number; events: number; meta: number; 'quota-history': number } {
    const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM meta) AS meta, (SELECT COUNT(*) FROM quota_history) AS quota').get()!;
    return { orders: Number(row.orders), events: Number(row.events), meta: Number(row.meta), 'quota-history': Number(row.quota) };
  }
  appendQuotaReading(reading: QuotaReading): void {
    this.db.prepare('INSERT INTO quota_history(at, source, reading) VALUES (?, ?, ?)').run(reading.at, reading.source, JSON.stringify(reading));
  }
  lastQuotaId(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM quota_history').get()!.id); }
  quotaRowsAfter(id: number, limit = 500): { id: number; reading: QuotaReading }[] {
    return this.db.prepare('SELECT id, reading FROM quota_history WHERE id > ? ORDER BY id LIMIT ?').all(id, limit)
      .map(row => ({ id: Number(row.id), reading: JSON.parse(row.reading as string) as QuotaReading }));
  }
  quotaHistory(options: QuotaHistoryOptions = {}): QuotaReading[] {
    const rows = options.source === undefined
      ? this.db.prepare('SELECT reading FROM quota_history ORDER BY id DESC LIMIT ?').all(options.limit ?? 500)
      : this.db.prepare('SELECT reading FROM quota_history WHERE source = ? ORDER BY id DESC LIMIT ?').all(options.source, options.limit ?? 500);
    return rows.reverse().map(row => JSON.parse(row.reading as string) as QuotaReading);
  }
  /** Full history is only for migration verification and portable exports. */
  allQuotaHistory(): QuotaReading[] {
    return this.db.prepare('SELECT reading FROM quota_history ORDER BY id').all().map(row => JSON.parse(row.reading as string) as QuotaReading);
  }
  /** The server-rendered board needs 24 distinct times per source; balance rules need exact anchors outside that window too. */
  tickQuotaHistory(current: readonly QuotaReading[], now: string): QuotaReading[] {
    const rows = new Map<number, QuotaReading>();
    const keep = (row: Record<string, unknown> | undefined) => { if (row) rows.set(Number(row.id), JSON.parse(row.reading as string) as QuotaReading); };
    for (const { source } of this.db.prepare('SELECT source FROM quota_history GROUP BY source').all()) {
      for (const row of this.db.prepare('SELECT id, reading FROM quota_history WHERE id IN (SELECT MIN(id) FROM quota_history WHERE source = ? GROUP BY at ORDER BY at DESC LIMIT 24)').all(source)) keep(row);
    }
    const dayAgo = new Date(Date.parse(now) - 24 * 3600 * 1000).toISOString();
    for (const reading of current) {
      if (reading.balance?.amount === undefined) continue;
      const args = [reading.source, reading.at];
      keep(this.db.prepare(`SELECT id, reading FROM quota_history WHERE source = ? AND at < ? AND ${HAS_BALANCE} ORDER BY id DESC LIMIT 1`).get(...args));
      const baseline = this.db.prepare(`SELECT id, reading FROM quota_history WHERE source = ? AND at < ? AND ${HAS_BALANCE} AND at >= ? ORDER BY id LIMIT 1`).get(...args, dayAgo)
        ?? this.db.prepare(`SELECT id, reading FROM quota_history WHERE source = ? AND at < ? AND ${HAS_BALANCE} ORDER BY id LIMIT 1`).get(...args);
      keep(baseline);
    }
    return [...rows].sort(([a], [b]) => a - b).map(([, reading]) => reading);
  }
  eventRows(options: { after?: number; tag?: string; limit?: number } = {}): (OrderEvent & { id: number })[] {
    const where = ['id > ?'];
    const args: (string | number)[] = [options.after ?? 0];
    if (options.tag) { where.push('tag = ? COLLATE NOCASE'); args.push(options.tag); }
    if (options.limit !== undefined) args.push(options.limit);
    return this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC${options.limit !== undefined ? ' LIMIT ?' : ''}`).all(...args).reverse().map(row => ({ ...this.event(row), id: Number(row.id) }));
  }
  eventsAfter(id: number): (OrderEvent & { id: number })[] { return this.eventRows({ after: id }); }
  lastEventId(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get()!.id); }
  close(): void { this.db.close(); }
  tags(): string[] { return this.db.prepare('SELECT tag FROM orders ORDER BY tag').all().map(row => row.tag as string); }
  private document(row: Record<string, unknown>): OrderDoc {
    return withRevision(JSON.parse(row.document as string) as OrderDoc, row.version as number);
  }
  read(tag: string): OrderDoc | undefined {
    validateTag(tag);
    const row = this.db.prepare('SELECT document, version FROM orders WHERE tag = ? COLLATE NOCASE').get(tag);
    return row ? this.document(row) : undefined;
  }
  all(): OrderDoc[] { return this.db.prepare('SELECT document, version FROM orders ORDER BY tag').all().map(row => this.document(row)); }
  write(doc: OrderDoc): void {
    validateTag(doc.order.tag);
    const version = revisionOf(doc);
    const json = JSON.stringify(doc);
    const result = version === 0
      ? this.db.prepare('INSERT OR IGNORE INTO orders(tag, document, updated, version) VALUES (?, ?, ?, 1)').run(doc.order.tag, json, doc.order.updated)
      : this.db.prepare('UPDATE orders SET document = ?, updated = ?, version = version + 1 WHERE tag = ? AND version = ?').run(json, doc.order.updated, doc.order.tag, version);
    if (!result.changes) throw new StaleWrite(doc.order.tag);
    withRevision(doc, version + 1);
  }
  transaction<T>(change: () => T): T {
    if (this.depth) return change();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = change(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  appendEvent(event: OrderEvent): void {
    this.db.prepare('INSERT INTO events(at, tag, type, by_actor, data) VALUES (?, ?, ?, ?, ?)').run(event.at, event.tag, event.type, event.by ?? null, event.data === undefined ? null : JSON.stringify(event.data));
  }
  events(options: { tag?: string; limit?: number } = {}): OrderEvent[] {
    const where = options.tag ? ' WHERE tag = ?' : '';
    const limit = options.limit ? ' LIMIT ?' : '';
    const args: (string | number)[] = [];
    if (options.tag) args.push(options.tag);
    if (options.limit) args.push(options.limit);
    const rows = this.db.prepare(`SELECT at, tag, type, by_actor, data FROM events${where} ORDER BY id DESC${limit}`).all(...args).reverse();
    return rows.map(row => this.event(row));
  }
  private event(row: Record<string, unknown>): OrderEvent {
    return { at: row.at as string, tag: row.tag as string, type: row.type as string, ...(row.by_actor !== null ? { by: row.by_actor as string } : {}), ...(row.data !== null ? { data: JSON.parse(row.data as string) } : {}) };
  }
  readMeta(name: string): unknown {
    if (name === 'order-attention') return this.attentionRows();
    if (name === 'usage' && this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage'").get()) return this.db.prepare('SELECT row FROM usage ORDER BY at, run, turn').all().map(r => JSON.parse(r.row as string));
    const row = this.db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  writeMeta(name: string, value: unknown): void {
    if (name === 'order-attention') {
      this.transaction(() => {
        this.ensureAttentionSchema();
        this.db.exec('DELETE FROM order_attention');
        const put = this.db.prepare('INSERT INTO order_attention(tag, seen_at, muted) VALUES (?, ?, ?)');
        for (const row of value as AttentionMark[]) put.run(row.tag, row.seen_at ?? null, Number(!!row.muted));
      });
      return;
    }
    if (name === 'usage') {
      this.transaction(() => {
        this.db.exec('DELETE FROM usage');
        const put = this.db.prepare('INSERT INTO usage(run, turn, at, worker, order_tag, row) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of value as import('../usage/types.ts').UsageRow[]) put.run(`${r.order}/${r.run}`, r.turn, r.at, r.worker, r.order, JSON.stringify(r));
        this.db.prepare('INSERT INTO meta(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, '[]');
      }); return;
    }
    this.db.prepare('INSERT INTO meta(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value));
  }
}
