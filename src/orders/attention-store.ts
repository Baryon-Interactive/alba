import type { OrderStore } from './store.ts';
import { SqliteStore } from './sqlite-store.ts';

export interface AttentionMark { tag: string; seen_at?: string; muted?: boolean }

export function attentionMarks(store: OrderStore): Map<string, AttentionMark> {
  let rows: AttentionMark[];
  if (store instanceof SqliteStore) {
    rows = store.attentionRows();
  } else rows = (store.readMeta('order-attention') as AttentionMark[] | undefined) ?? [];
  return new Map(rows.map(row => [row.tag, row]));
}

export function saveAttentionMarks(store: OrderStore, changes: AttentionMark[]): void {
  if (!changes.length) return;
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      store.ensureAttentionSchema();
      const put = store.db.prepare(`INSERT INTO order_attention(tag, seen_at, muted) VALUES (?, ?, COALESCE(?, 0))
        ON CONFLICT(tag) DO UPDATE SET seen_at = CASE WHEN seen_at IS NULL OR excluded.seen_at > seen_at THEN excluded.seen_at ELSE seen_at END,
        muted = COALESCE(?, muted)`);
      for (const row of changes) {
        const muted = row.muted === undefined ? null : Number(row.muted);
        put.run(row.tag, row.seen_at ?? null, muted, muted);
      }
    } else {
      const marks = attentionMarks(store);
      for (const row of changes) {
        const old = marks.get(row.tag);
        const seen_at = [old?.seen_at, row.seen_at].filter((at): at is string => !!at).sort().pop();
        marks.set(row.tag, { tag: row.tag, muted: row.muted ?? old?.muted ?? false, ...(seen_at && { seen_at }) });
      }
      store.writeMeta('order-attention', [...marks.values()]);
    }
  });
}
