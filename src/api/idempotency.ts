import { createHash } from 'node:crypto';
import { SqliteStore, type IdempotencyReceiptRow } from '../orders/sqlite-store.ts';
import type { OrderStore } from '../orders/store.ts';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface FileIdempotencyStore {
  version: 1;
  receipts: Record<string, IdempotencyReceiptRow>;
}

const CLAIM_TIMEOUT_MS = 10 * 60_000;
const META_NAME = 'idempotency';

/** Canonical JSON serialization with recursively sorted object keys so equivalent JSON bodies hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function bodyHashOf(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

function readFileStore(store: OrderStore): FileIdempotencyStore {
  const raw = store.readMeta(META_NAME) as Partial<FileIdempotencyStore> | undefined;
  if (!raw || typeof raw !== 'object' || !raw.receipts || typeof raw.receipts !== 'object') {
    return { version: 1, receipts: Object.create(null) };
  }
  return { version: 1, receipts: Object.assign(Object.create(null), raw.receipts) };
}

function writeFileStore(store: OrderStore, data: FileIdempotencyStore): void {
  store.writeMeta(META_NAME, data);
}

export interface ClaimOwner { instanceId: string; createdAt: string }
export type ClaimResult =
  | { outcome: 'claimed'; owner: ClaimOwner }
  | { outcome: 'replay'; statusCode: number; responseBody: string }
  | { outcome: 'mismatch' }
  | { outcome: 'in_progress' };

/** Called with the project serve lock held. Legacy pending receipts have no owner. */
export function clearForeignClaims(store: OrderStore, instanceId: string): void {
  store.transaction(() => {
    if (store instanceof SqliteStore) return store.clearForeignClaims(instanceId);
    const data = readFileStore(store);
    const foreign = Object.values(data.receipts).filter(r => r.status === 'in_progress' && r.instance_id !== instanceId);
    for (const r of foreign) delete data.receipts[r.idempotency_key];
    if (foreign.length) writeFileStore(store, data);
  });
}

export function claimIdempotency(
  store: OrderStore,
  input: { key: string; method: string; route: string; bodyHash: string; now: Date; instanceId: string },
): ClaimResult {
  const createdAt = input.now.toISOString();
  const cutoff = new Date(input.now.getTime() - IDEMPOTENCY_TTL_MS).toISOString();
  return store.transaction((): ClaimResult => {
    const sql = store instanceof SqliteStore ? store : undefined;
    const data = sql ? undefined : readFileStore(store);
    if (sql) sql.purgeExpiredIdempotencyReceipts(cutoff);
    if (data) {
      const expired = Object.values(data.receipts).filter(r => r.created_at < cutoff);
      for (const r of expired) delete data.receipts[r.idempotency_key];
      if (expired.length) writeFileStore(store, data);
    }

    const existing = sql?.getIdempotencyReceipt(input.key) ?? data?.receipts[input.key];
    if (existing) {
      const abandoned = existing.status === 'in_progress' && (existing.instance_id !== input.instanceId ||
        input.now.getTime() - Date.parse(existing.created_at) >= CLAIM_TIMEOUT_MS);
      if (abandoned) sql?.deleteIdempotencyReceipt(input.key);
      else {
        if (existing.method !== input.method || existing.route !== input.route || existing.body_hash !== input.bodyHash) return { outcome: 'mismatch' };
        if (existing.status === 'in_progress') return { outcome: 'in_progress' };
        return { outcome: 'replay', statusCode: existing.status_code ?? 200, responseBody: existing.response_body ?? '{}' };
      }
    }
    const receipt: IdempotencyReceiptRow = {
      idempotency_key: input.key, method: input.method, route: input.route, body_hash: input.bodyHash,
      status: 'in_progress', created_at: createdAt, updated_at: createdAt, instance_id: input.instanceId,
    };
    if (data) {
      data.receipts[input.key] = receipt;
      writeFileStore(store, data);
    } else sql!.insertIdempotencyReceipt(receipt);
    return { outcome: 'claimed', owner: { instanceId: input.instanceId, createdAt } };
  });
}

function ownsClaim(receipt: IdempotencyReceiptRow | undefined, owner: ClaimOwner): boolean {
  return receipt?.status === 'in_progress' && receipt.instance_id === owner.instanceId && receipt.created_at === owner.createdAt;
}

export function completeIdempotency(
  store: OrderStore,
  key: string,
  owner: ClaimOwner,
  statusCode: number,
  responseBody: string,
  now: Date,
): void {
  const nowIso = now.toISOString();
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      if (!ownsClaim(store.getIdempotencyReceipt(key), owner)) return;
      store.completeIdempotencyReceipt(key, statusCode, responseBody, nowIso);
      return;
    }
    const data = readFileStore(store);
    const existing = data.receipts[key];
    if (!ownsClaim(existing, owner)) return;
    data.receipts[key] = {
      ...existing,
      status: 'completed',
      status_code: statusCode,
      response_body: responseBody,
      updated_at: nowIso,
    };
    writeFileStore(store, data);
  });
}

export function releaseIdempotency(store: OrderStore, key: string, owner: ClaimOwner): void {
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      if (!ownsClaim(store.getIdempotencyReceipt(key), owner)) return;
      store.deleteIdempotencyReceipt(key);
      return;
    }
    const data = readFileStore(store);
    if (ownsClaim(data.receipts[key], owner)) {
      delete data.receipts[key];
      writeFileStore(store, data);
    }
  });
}
