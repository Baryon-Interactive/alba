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
    return { version: 1, receipts: {} };
  }
  return { version: 1, receipts: { ...raw.receipts } };
}

function writeFileStore(store: OrderStore, data: FileIdempotencyStore): void {
  store.writeMeta(META_NAME, data);
}

export type ClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; statusCode: number; responseBody: string }
  | { outcome: 'mismatch' }
  | { outcome: 'in_progress' };

/**
 * Atomically purges receipts older than 24 hours, checks for an existing receipt under `key`,
 * and either returns replay / mismatch / in_progress or claims the key as in_progress.
 */
export function claimIdempotency(
  store: OrderStore,
  input: { key: string; method: string; route: string; bodyHash: string; now: Date },
): ClaimResult {
  const nowIso = input.now.toISOString();
  const cutoffMs = input.now.getTime() - IDEMPOTENCY_TTL_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();

  return store.transaction((): ClaimResult => {
    if (store instanceof SqliteStore) {
      store.purgeExpiredIdempotencyReceipts(cutoffIso);
      const existing = store.getIdempotencyReceipt(input.key);
      if (existing) {
        if (existing.method !== input.method || existing.route !== input.route || existing.body_hash !== input.bodyHash) {
          return { outcome: 'mismatch' };
        }
        if (existing.status === 'in_progress') return { outcome: 'in_progress' };
        return {
          outcome: 'replay',
          statusCode: existing.status_code ?? 200,
          responseBody: existing.response_body ?? '{}',
        };
      }
      store.insertIdempotencyReceipt({
        idempotency_key: input.key,
        method: input.method,
        route: input.route,
        body_hash: input.bodyHash,
        status: 'in_progress',
        created_at: nowIso,
        updated_at: nowIso,
      });
      return { outcome: 'claimed' };
    }

    const data = readFileStore(store);
    let pruned = false;
    for (const [k, receipt] of Object.entries(data.receipts)) {
      if (Date.parse(receipt.created_at) < cutoffMs) {
        delete data.receipts[k];
        pruned = true;
      }
    }
    const existing = data.receipts[input.key];
    if (existing) {
      if (pruned) writeFileStore(store, data);
      if (existing.method !== input.method || existing.route !== input.route || existing.body_hash !== input.bodyHash) {
        return { outcome: 'mismatch' };
      }
      if (existing.status === 'in_progress') return { outcome: 'in_progress' };
      return {
        outcome: 'replay',
        statusCode: existing.status_code ?? 200,
        responseBody: existing.response_body ?? '{}',
      };
    }
    data.receipts[input.key] = {
      idempotency_key: input.key,
      method: input.method,
      route: input.route,
      body_hash: input.bodyHash,
      status: 'in_progress',
      created_at: nowIso,
      updated_at: nowIso,
    };
    writeFileStore(store, data);
    return { outcome: 'claimed' };
  });
}

export function completeIdempotency(
  store: OrderStore,
  key: string,
  statusCode: number,
  responseBody: string,
  now: Date,
): void {
  const nowIso = now.toISOString();
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      store.completeIdempotencyReceipt(key, statusCode, responseBody, nowIso);
      return;
    }
    const data = readFileStore(store);
    const existing = data.receipts[key];
    if (!existing) return;
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

export function releaseIdempotency(store: OrderStore, key: string): void {
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      store.deleteIdempotencyReceipt(key);
      return;
    }
    const data = readFileStore(store);
    if (key in data.receipts) {
      delete data.receipts[key];
      writeFileStore(store, data);
    }
  });
}
