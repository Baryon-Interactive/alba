import { stateStore, type StateProject } from '../orders/backend.ts';
import { readStateJson, writeStateFile } from '../orders/state-files.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import type { UsageRow } from './types.ts';

export function usageRows(project: StateProject, since = ''): UsageRow[] {
  const store = stateStore(project);
  if (store instanceof SqliteStore) return store.db.prepare('SELECT row FROM usage WHERE at >= ? ORDER BY at, run, turn').all(since).map(r => JSON.parse(r.row as string) as UsageRow);
  return readStateJson<UsageRow[]>(project, '_usage.json', []).filter(r => r.at >= since);
}
export function replaceRunUsage(project: StateProject, run: string, rows: UsageRow[]): void {
  if (!rows.length) return;
  replaceUsageRuns(project, [{ order: rows[0].order, run, rows }]);
}
/** One file rewrite or SQL transaction per collection pass, including large backfills. */
export function replaceUsageRuns(project: StateProject, replacements: { order: string; run: string; rows: UsageRow[] }[]): void {
  if (!replacements.length) return;
  const store = stateStore(project);
  store.transaction(() => {
    if (store instanceof SqliteStore) {
      store.db.prepare("INSERT OR IGNORE INTO meta(name, value) VALUES ('usage', '[]')").run();
      const remove = store.db.prepare('DELETE FROM usage WHERE run = ?');
      const insert = store.db.prepare('INSERT INTO usage(run, turn, at, worker, order_tag, row) VALUES (?, ?, ?, ?, ?, ?)');
      for (const { order, run, rows } of replacements) {
        const key = `${order}/${run}`; remove.run(key);
        for (const row of rows) insert.run(key, row.turn, row.at, row.worker, row.order, JSON.stringify(row));
      }
    } else {
      const keys = new Set(replacements.map(r => `${r.order}/${r.run}`));
      const all = usageRows(project).filter(r => !keys.has(`${r.order}/${r.run}`));
      writeStateFile(project, '_usage.json', JSON.stringify([...all, ...replacements.flatMap(r => r.rows)]));
    }
  });
}
