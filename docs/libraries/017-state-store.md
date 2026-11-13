# 017. State stores

The project state folder contains order documents, the append-only event stream, small metadata records, and a SQLite database when the SQLite backend is selected. New projects default to `state: { backend: sqlite }`. A legacy folder with order JSON files and no database continues using the file backend until an operator runs migration; `state: { backend: files }` keeps that choice explicit.

SQLite uses `state.sqlite` with WAL mode, a five-second busy timeout, foreign keys, a numbered `schema_version` migration table, `orders`, `events`, `quota_history`, and `meta`. `orders` keeps the complete `OrderDoc` JSON plus `updated` and a version. `events` is indexed by tag and time. `meta` stores small JSON values such as the table fingerprint and side state. The service retries a stale write by rereading and merging the caller's change a few times; a stage or other validation error still wins after rereading. The file backend stores the same version in each JSON document and checks it before the atomic rename.

Use the commands below from a project folder:

```text
alba state migrate --dry-run
alba state migrate
alba state export --out plain-state
alba state check
```

Migration refuses a live `serve.lock`, imports orders, events, quota history and metadata in one transaction, checks counts and deep equality, then moves the source files (including `quota-history.jsonl`) to `_files-backup-<time>/`. Nothing is deleted. Export writes the plain JSON layout, including every quota reading in `quota-history.jsonl` in insertion order, and can be re-imported without loss. Check and migration/export counts include `orders`, `events`, `meta` and `quota-history`.

The following side state is in SQLite `meta` for the SQLite backend: table import metadata; resource leases; loop watch marks; commit-nudge marks; project pick choices; setting confirmations; spend approvals; decisions; reference indexes; and dispatch-table backups. Quota history has its own table. The file backend keeps these at their original paths. Run prompts, worker logs and handoff files under `runs/` remain files because tools tail them and they are large text. Fetched reference images, routing prompts/logs, classifier output, and external project/library files also remain files because they are source material or operational logs owned by another tool. `serve.lock` and `_write.lock` remain coordination files and are never migrated.

Schema migration 3 creates `quota_history(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, reading TEXT NOT NULL)` with a `(source, at)` index, a `(source, id)` index and a partial index for valid numeric balance readings. Opening a schema-2 database converts its old quota-history metadata into rows and removes that metadata entry in the same transaction, exactly once. Recording a tick inserts one row per quota source, batched in one transaction, without reading or rewriting the existing history or `meta`. The file backend still appends to `quota-history.jsonl`.

Quota readers have these explicit bounds:

- Tick and legacy board snapshots load the latest **24 distinct timestamps per recorded source** (the first inserted reading wins for a duplicate timestamp, as on the legacy board), plus at most **two balance anchors per current source**. The anchors are the last inserted valid balance before the current reading, and the first inserted valid balance in the preceding 24 hours, falling back to the first valid balance ever if that day has none. This preserves `balanceDrop`, the legacy 24-hour `balanceChange`, and the legacy board's 24-row table even after arbitrarily many failed readings. SQL applies the filters and limits before parsing JSON; no full history is returned to a tick.
- `readQuotaHistory` and the chart API load the latest **500 readings by default**, optionally filtered by source in SQL. The API keeps its existing **5,000 maximum** and chronological insertion order; the React workers chart requests 500 for its worker's source.
- The hub stores the last quota **ID** and checks `MAX(id)`, then streams only rows after that ID in batches of **500**. Later scans drain any backlog. Initializing or polling it never loads old history. File streams continue to use byte offsets.
- Only migration verification, explicit full-file compatibility reads and export load the complete history. No normal tick, board or stream caller uses that path. No readings are deleted by the bounded queries.

`events` queries use SQL filters and limits, and `Orders.all()` is one query on SQLite. The file backend remains available for transparent fallback and comparison.

Run `node --disable-warning=ExperimentalWarning test/bench-state.ts` to reproduce the synthetic benchmark using temporary directories only. On Node 26.13.0, the median of 15 warm samples measured these wall-clock times in milliseconds (one warm-up excluded):

| Operation | files | sqlite |
|---|---:|---:|
| `all()` (500 orders) | 164.591 | 0.745 |
| stages of all orders | 398.478 | 1.910 |
| `events({limit: 200})` (20,000 events) | 11.657 | 0.265 |
| one order write | 2.845 | 0.434 |
| record one tick + read history (1 MiB quota history) | 9.563 | 14.405 |

The quota workload uses an otherwise empty project, 6,437 initial readings (1,048,581 JSONL bytes), four sources and one inserted reading per source per tick. It includes the complete tick's history read and recording through the same path used in production; each timed tick appends four readings. SQLite was slower for this small quota workload on this run: bounded result parsing and append-only writes remove the growing TEXT rewrite, but SQL calls, JSON predicates and transaction durability still have costs. Timings vary with disk and machine load; these measurements do not imply a capacity guarantee.

Rework validation: root typecheck passed; the full suite passed 319/319 tests with `ALBA_TEST_STORE=files` and again with `ALBA_TEST_STORE=sqlite`. UI `tsc`, 83 Vitest tests, `vite build`, and the i18n check (768 texts) passed. Quota regression tests verify three ticks insert `3 × sources` rows without any metadata writes, schema-2 upgrades run once, import/export/re-import equality and backups, exact balance/legacy-board behavior with bounded history, and hub ID batches without reading historical metadata. These checks use synthetic temporary state; no real project was migrated.
