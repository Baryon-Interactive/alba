# Compact producer read fixture

The generic fixture in test/fixtures/producer-reads.ts uses a fixed clock, injected git and memory readings, and a worker whose launch program is never executed. Tests exercise both file and SQLite stores. No model or external state is used.

The status response below contains 836 characters (the text field, excluding JSON encoding).

```text
Status 2026-01-10T12:00:00.000Z; 5 open orders

running=2 draft=1 held=1 waiting-needs=1

Capacity (4)
memory 12.0 GB free / minimum 4 GB
kind code 2/3; free 1: no ready order
kind art 0/1; free 1: needs: NEEDS
resource build 1/1; free 0

Stalled runs (tick rule) (1)
SLOW: no commit for 2 h (limit 60 min).

Open cases by trigger (1)
commit-reminder (1): stall/SLOW

Held over 3 days (1)
HOLD held 4 days

Producer rule modes (1)
remind: auto (nudge)

Open orders; commit/age in minutes (? = unknown) (5)
running: RETRY code worker=builder commit=? (?m) age=10m report=-
running: SLOW code worker=builder commit=2026-01-10T10:00:00.000Z (120m) age=180m report=-
waiting-needs: NEEDS art worker=- commit=? (?m) age=?m report=-
held: HOLD code worker=- commit=? (?m) age=?m report=-
draft: BASE art worker=- commit=? (?m) age=?m report=-
```

The size test also constructs 200 open orders and checks the 6,000-character limit and omission marker. Filtered collections provide omitted details.

Validation after merging `main`:

- `pnpm run typecheck`: passed.
- `pnpm test`: 482 tests passed, no failures or skipped tests.
- `pnpm -C ui run typecheck`: passed.
- `pnpm run ui:build`: passed.

The fixture tests cover both file and SQLite state stores, use injected probes and never launch a model. They also verify filtering, page reconstruction and counts, full single-fact reads, current stored facts, held work outside WIP, superseded/closed case exclusion, and the 200-order size bound. Listed MCP schemas retain no top-level combinators.
