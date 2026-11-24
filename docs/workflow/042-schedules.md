# 042. Recurring order schedules

Uses the terms of [001](../concepts/001-concepts.md), [002](002-orders-and-stages.md), [004](004-tick.md) and [010](../console/010-api.md).

A schedule creates a queued work order from a Markdown template file on a timetable, surviving `alba serve` restarts without creating duplicates or a burst of missed runs.

## Configuration

Add a top-level `schedules:` list to the project file (`alba.yaml`; JSON Schema in [`schema/project.schema.json`](../../schema/project.schema.json)):

```yaml
schedules:
  - id: nightly-smoke
    order: templates/nightly-smoke.md
    tag: NIGHT-{date}
    daily_at: "02:00"
    catch_up: latest
    max_open: 1
    enabled: true
    kind: build
    worker: coder-a
    priority: 10
    needs: [BASE1]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique identifier matching `[a-z0-9-]+`. |
| `order` | yes | Path to a Markdown template file, relative to `alba.yaml`. |
| `tag` | yes | Tag pattern with `{date}` (`YYYYMMDD`, local time) and optional `{time}` (`HHMM`, local time). The expanded tag must be a valid order tag. |
| `every_minutes` | one of three | Whole number `>= 15`. Fires on fixed intervals aligned to whole minutes. |
| `daily_at` | one of three | `HH:MM` in 24-hour local time. |
| `cron` | one of three | Five-field expression (`minute hour day-of-month month day-of-week`, local time) supporting `*`, comma lists, `a-b` ranges and `*/n` steps (`0` and `7` both mean Sunday). |
| `catch_up` | no | `latest` (default) or `none`. |
| `precheck` | no | Command to run in the project's base checkout before creating an automatic order. An array names the program and its arguments directly. A string runs through the platform shell. |
| `max_open` | no | Whole number `>= 1` (default `1`). |
| `enabled` | no | `true` (default) or `false`. |
| `kind`, `worker`, `priority`, `needs` | no | Order fields passed to each created order as `alba orders add` sets them. |

Exactly one of `every_minutes`, `daily_at` or `cron` must be set.

### Template placeholders and order metadata

When a schedule fires for a planned time, Alba reads `order` and replaces:

- `{date}` — `YYYYMMDD` in local time for the planned time
- `{time}` — `HHMM` in local time for the planned time
- `{planned_at}` — ISO 8601 UTC timestamp of the planned time
- `{schedule}` — the schedule `id`

The order's title comes from the first `# Heading` of the expanded template (or `<id> (<date>)` if none is present). Per-kind order templates (`orders.templates`) fill any missing sections as with `alba orders add`, the order is queued immediately, and the order records `source: "schedule:<id>"` and `planned_at` (displayed in `alba orders show` and on the console Order page).

## Keys, receipts and catch-up

Each serve loop pass and each real `alba tick` evaluates enabled, non-paused schedules:

- **`catch_up: latest` (default)**: computes the latest planned time at or before the current clock. After a multi-day downtime, only that most recent missed planned time fires once — never a burst of every missed slot.
- **`catch_up: none`**: missed planned times older than the current pass interval are skipped; only a planned time due within the last pass interval fires.

After a schedule has an observed slot, each gap between observed slots gets one `missed` history row. It gives the count and the first and last planned times. On first observation Alba only considers the latest due slot. Repeating the pass does not count a gap again.

A precheck has 60 seconds to finish. Exit zero allows creation. A nonzero exit records `skipped-precheck` and the last 20 lines of combined output. A timeout or failure to launch the command records `precheck-failed`. Neither outcome creates an order or changes its failure streak. Manual runs bypass a configured check and carry `precheck: "bypassed"` on their receipt. Other limits still apply.

Every fire is keyed on `(schedule id, planned time)`:

- On the **SQLite backend**, the receipt (`schedule_fires` table, schema version 8) and the new order are written inside the same `BEGIN IMMEDIATE` transaction.
- On the **file backend**, `_schedules.json` and the new order are written inside the same locked, journaled `FileStore` transaction (`writeFileAtomic`).

A restart, a second `alba serve`, or a concurrent `alba tick` therefore cannot create the same scheduled instance twice. If the expanded tag or its work-order file already exists, the fire is recorded as `skipped` with a `schedule-skipped` notice and never overwrites the existing order or file.

## `max_open` and loop protection

- **`max_open`**: if at least `max_open` orders created by this schedule are not yet ended (`merged`, `cancelled` or `dropped`), the fire is skipped and recorded with the reason.
- **Daily fire limit**: at most **48** created orders per schedule per local calendar day. Further fires that day are skipped and recorded with the reason.
- **Consecutive-failure auto-pause**: when the last **3** orders created by a schedule (since its last resume) all ended `failed` or `dropped`, the schedule pauses itself in durable state, records the reason, and opens a producer card with trigger `schedule-paused`. (`schedule-paused` is in `PRODUCER_TRIGGERS` and not in `DEFAULT_SESSION_TRIGGERS`.) Resuming the schedule clears the pause, closes the card and starts a fresh streak.

## Command line

```sh
alba schedules list [--json]
alba schedules run <id> [--json]
alba schedules pause <id> [--note "why"] [--json]
alba schedules resume <id> [--json]
```

- `list` shows each schedule's state (`active`, `paused`, `paused (auto)`, `disabled`), cadence, next planned time, last fire (with created order tag or skip reason) and open count.
- The health line shows why a schedule is held and the USD spend for runs of its orders started in the past seven days. An unavailable cost or failed spend read shows `unknown`. The last ten history rows are newest first. Consecutive skips for the same reason show their count and time range. Expand **History** on the Tick page to read the output.
- `run <id>` fires immediately, keyed on the current minute so running it twice in the same minute creates one order.
- `pause <id>` and `resume <id>` persist in project state (`schedule_state` table on SQLite or `_schedules.json` on the file backend) and never edit `alba.yaml`.

## API and console

- `GET /api/schedules?project=<id>` returns `ScheduleList` with the same fields as `alba schedules list`.
- `POST /api/schedules/:id/run`, `POST /api/schedules/:id/pause` (`{ project?, reason? }`) and `POST /api/schedules/:id/resume` perform the three actions and support `Idempotency-Key` ([010](../console/010-api.md#idempotent-writes)).
- The console's **Tick** page includes a **Schedules** section listing every schedule with **Run now**, **Pause** and **Resume** actions, and the **Order** page displays `Source` (`schedule:<id>`) and `Planned` under Definition.
