# 002. Orders and stages

Uses the terms of [001](../concepts/001-concepts.md).

## 1. Stages

The stage of an order is computed from stored facts by one pure function (`inferStage` in `src/orders/stage.ts`). The first matching row wins, so the rows are mutually exclusive and cover every case.

| # | Stage | Who is being waited for | Condition |
|---|---|---|---|
| 1 | `cancelled` | nobody | the last relevant action is `cancel` |
| 2 | `merged` | nobody | approved or closed (`merged-elsewhere`, `done-by-lead`), and not sent back |
| 3 | `held` | a person, to release | `hold` without a later `release` |
| 3a | `waiting-children` | child orders | an accepted split has children still open. The stage reason gives their count ([split and integrate](045-split-and-integrate.md)) |
| 4 | `awaiting-user` | a person, to answer or to click a card | a completed split awaits a decision, or the current report is `waiting` and has a question (`waiting_for`: `answer` unless the report or the table's status word says `card`; document 011) |
| 5 | `awaiting-review` | a person, to review | the current report is `ready` |
| 6 | `blocked` | a person, to decide | the current report is `blocked` |
| 7 | `failed` | a person, to look | the current report is `failed` |
| 8 | `dropped` | a person, to look | the current report is `dropped` |
| 9 | `running` | the worker | a run is open |
| 10 | `monitoring` | the monitor | no open run, and the current report is `monitoring`: a long job runs on its own and the tick checks it (document 014) |
| 11 | `idle` | nobody in particular | no open run, and the worker waits without a question, or the last run ended and nothing is queued |
| 12 | `waiting-needs` | other orders | queued, but a needed order is not merged |
| 13 | `queued` | a worker slot | queued and ready |
| 14 | `draft` | a person, to queue it | none of the above |

A report is *current* only if no `queue`, `rework` or `answer` action and no run start came after it. A rework after a `ready` report puts the order back in `queued`; a new run after a `blocked` report makes it `running` again. `running` is checked before `waiting-needs` on purpose: an order already being worked on is shown as running.

## 2. Human actions

`queue`, `cancel`, `hold`/`release`, `stop` (end the open run's processes and hold the order; document 005), `approve` (the order is merged), `close` (`merged-elsewhere` with a commit on the base branch, or `done-by-lead` with a note of at least 10 characters; marks the order merged and clears `cancelled` without counting a worker run; document 006), `rework --note` (send it back; the note goes to the next run) and `answer` (the order waits on a worker's question: the answer goes to the next run, in the same conversation when the engine can continue it; document 005). Which are allowed depends on the stage (`actionProblem`): `approve` needs `awaiting-review` (or `idle` with `--override`) and no open run: a run that is still going could change the branch under the approval (the JSON interface offers it only for `awaiting-review`); `close` is allowed from every stage except `running`, `monitoring` (stop the run first) and `merged`; `answer` is refused while the order waits for a card; `rework` is refused for merged or cancelled orders; `release` only for held ones; `stop` only with an open run. `hold`, `stop` and `cancel` of a running order stop its process and everything under it after checking its identity (a cancel leaves a process it cannot verify alone). Everything else is a fact recorded by a worker or by the tick.

`alba orders ready` lists orders in `queued` whose `needs` are all merged.

A project can configure `phases` by order kind. Each list begins with a `read-only` or `split` phase, optionally continues with more `read-only` phases, and ends with one `write` phase. Give each phase a unique `id` and optionally a `role` and positive `timeout_minutes`. Set `--phases none` on `orders add` or `orders set` to use a single ordinary run for that order.

## 3. Files

Orders and events live in the project's `state_dir`. SQLite is the default backend; see [state storage](../libraries/017-state-store.md). The explicit file backend uses:

- `<TAG>.json`: `{ version: 1, order, runs, reports, actions }` for one order.
- `events.jsonl`: one JSON object per line, `{ at, tag, type, data }`.
- `quota-history.jsonl`: one quota reading per source per tick (document 003).
- `_table.json`: the header and separator of the imported Markdown table, so `table render` can reproduce its look.

File-backend documents are written to a temporary name in the same folder and then renamed. SQLite writes use transactions and optimistic versions. A service lock prevents two service owners sharing a state directory.

## 4. Structured report

```json
{
  "status": "progress | waiting | ready | blocked | failed | dropped",
  "summary": "one sentence",
  "question": "at most one concrete question for a person (empty or left out when none; only with waiting or blocked)",
  "options": "2 to 4 choices for the question, the recommended one first (optional; document 011)",
  "waiting_for": "card or answer (optional, only with waiting)",
  "evidence": ["paths"],
  "commits": ["abc1234"]
}
```

It is either a plain `.json` file or a fixed block at the end of a free-text file such as `<TAG>.last.txt`:

```
--- alba-report ---
{"status":"ready","summary":"Pause menu works","question":"","evidence":["docs/pause.md"],"commits":["abc1234"]}
--- end ---
```

A worker launched by Alba receives `ALBA_RUN` (for example `T1/r2`) in its environment and prompt. Copy it into the JSON `"run"` field in the final block and any standalone report. The order-local id (`r2`) is also accepted. Older workers may omit the field. Finish and sync reject a mismatched id or a delivery file modified before the current run started and record a `stale-report` event. An older file can be inherited from the immediately preceding run on a same-session resume or worker handover. An unsigned inherited file must match the previous run's recorded delivery path.

If a file has several blocks the last one wins. The same JSON may also be a `<TAG>.report.json` file. Document 005 says how a worker is told to write it. `alba orders report <TAG> --file <file>` records it. Nothing is guessed from free text.

## 5. Importing a Markdown dispatch table

Many projects already keep their queue in a hand-written table. `alba table import` reads it using the `dispatch_table` mapping in `alba.yaml`:

- `status_column`, `order_column`, `worker_column`, `needs_column` (1-based). The order cell starts with the tag (`tag_pattern`, default letters + digits + optional letters); the rest is the title.
- `status_map`: the table's status words to stages. A word that is not mapped stops the import with a list; nothing is guessed and nothing is written.
- `section`: use the first table under a heading that contains this text (default: the first table in the file).
- `tag_exclude`: a pattern for things that look like tags but are not (decision numbers, commit hashes).
- `untagged`: `error` (default) or `synthetic` to give a row without a tag a stable made-up tag.
- `merged_list`: a line like `Merged: A, B, C` naming orders that are done, so that `needs` can refer to them.
- `merged_marker`: in the needs column, tags written right before this word (`A, B merged`) are treated as already merged.
- `kind_rules`: a list of `{ match, kind, heavy }`; the first rule whose regular expression matches the words of a row sets its kind, and the first one with a `heavy` sets its heavy class. A row no rule matches keeps an empty kind.
- `default_kind`: the kind for rows no rule matches.

Importing records facts that match the table (a `running` row gets an open run, a card waiting for a person gets a waiting report with a question, and so on) and marks them as imported. Importing again only applies a row whose status word changed; real runs and reports are never overwritten. The Markdown file is never changed.

`alba table render` writes the table back with the same columns. The status word is the one the row had at import if it still means the order's stage, otherwise the first word in `status_map` for that stage. Merged and cancelled orders that have no word are left out.

### Writing the table back

`alba table render --write [--file <copy>]` puts the status words back into the one table of the dispatch file (or of a copy of it, `--file`). Without `--write` nothing is written. The text outside the table, the header and separator, the line endings and every row that already says the right thing stay as they were; only the status, order, worker and needs cells of a row that changed are rewritten, and the other columns keep their text. An order that has no row yet is added after the last row. A row whose stage has no status word in `status_map` (a merged order, for instance) is left as written: the tool does not invent a word. Before writing, the file is copied to `<state_dir>/backups/`. The write is refused if the table was edited since the last import (the import keeps a fingerprint of the table), so that nothing a person wrote is lost; run `alba table import` first. After writing, the table is read back, so that orders added as rows know their row.

### Needs and starting branch from a table row

By default every tag found in the needs column is a need, which also catches tags that are only mentioned ("A delivered (not merged)"). With `needs_markers` (a list of words such as `[merged, after]`, plus the `merged_marker`) only two forms count: the whole cell is a list of tags ("A, B", "A and B"), or tags are written right before a marker ("A, B merged", "after" styles). `base_pattern` is a regular expression with one group; the first match anywhere in the row (for example `from (\S+)` style text) becomes the order's `base_ref`, the local branch `alba run` makes its worktree from. A remote-tracking ref is refused. `alba orders add --base-ref <branch>` sets it by hand.

## 6. Acceptance sections, templates and preflight

An order file can make its mechanical expectations explicit with `## Acceptance`, `## Evidence`, `## Paths` and `## Standing rules` sections (numbered headings with notes such as `## 4. Acceptance (lead)` also count). Use one bullet per acceptance sentence; evidence bullets use `path: what`, while path bullets use `allow:`, `deny:`, `max-lines: <number> for <glob>` or `tool-dir: <dir> (<tool>)`. `alba verify` reports a missing Acceptance section as a warning and enforces the declared evidence and path rules.

### Per-kind order templates

`orders.templates` in `alba.yaml` supplies default sections by kind (`default` applies to kinds without their own entry; an empty mapping such as `docs: {}` fills nothing for that kind):

```yaml
orders:
  templates:
    ue:
      file: templates/orders/ue.md
      acceptance: ["Packaged autoplay of the changed screen exits 0 (python tools/run_autoplay.py)"]
      evidence: ["artifacts/{tag_lower}/*.png: named captures of each changed screen"]
      paths: ["allow: game/Source/**"]
      rules: ["Unreal: C++ and generated assets only, no hand-made Blueprint assets."]
    docs: {}
```

`file` is relative to `alba.yaml`; inline `acceptance`, `evidence`, `paths` and `rules` lists win over the same section in `file`. Placeholders `{tag}`, `{tag_lower}` and `{kind}` are expanded. When an order is created with a body (`createOrder`: `orders add --body-file`, the API, design intake and producer `add-order`) or a planned draft is accepted (`acceptDraft`), Alba appends only the sections missing from the body (even an empty written heading counts as present and is never altered), in the order `Acceptance`, `Evidence`, `Paths`, `Standing rules`, right before a trailing `Report` section when present or else at the end, and records `order-template-filled` (`{ kind, sections }`). Orders created without a body are not filled. When `drafting.template` is not set and the planned order's kind has a template, `draftingContext` places the kind's sections into the built-in drafting skeleton instead of empty `Acceptance` and `Evidence` headings. Shipped project-neutral examples live in [ue.md](../../templates/orders/ue.md), [code.md](../../templates/orders/code.md) and [docs.md](../../templates/orders/docs.md).

### Preflight before dispatch

`alba orders preflight <TAG> [--json]` checks an order against its base branch before a worker spends a run on it, records `preflight-checked` (`{ hash, base_head, ok, problems }`), prints each finding with its fix, and exits `1` when any `hold` problem is present (`0` otherwise):

1. **`file`** (`hold`): the order has a work-order file and `parseOrderSections` finds a `## Acceptance` section with bullet items. Fix: create `<TAG>-<slug>.md` or add `## Acceptance` bullets.
2. **`sections`** (`warn`): `## Evidence` or `## Paths` is missing while the kind's template defines it. Fix: the exact section bullets from the template.
3. **`paths`** (`hold`): when `## Paths` declares `allow:` globs, every repository path named in the body outside reading headings (`read`, `background`, `context`, `reference`, `report`) that exists on the base (`git cat-file`) must match an `allow:` glob and no `deny:` glob. Fix: the exact `- allow: <path>` bullet.
4. **`needs`** (`hold`): every listed need is a known order and is not `cancelled` (unmerged valid needs are already shown by stage `waiting-needs`). Fix: drop the need in the order's fields or dispatch table, or close the needed order if its work is on the base.
5. **`tool-dirs`** (`warn`): for each `orders.preflight.tool_dirs.<tool>: { dir, kinds? }` matching the order's kind (or any kind when `kinds` is omitted), the body must name `dir`. Fix: `- tool-dir: <dir> (<tool>)` under `## Paths`.
6. **`checks`** (`hold`, only when `orders.preflight.run_checks: true`): commands from fenced blocks under `## Checks` and Acceptance bullets of the form ``command: `<cmd>` `` run through the platform shell in a detached checkout of the base head under `<state_dir>/preflight/<TAG>` (after `dispatch.provision` if set), each bounded by `orders.preflight.check_timeout_seconds` (default `300`), stopping at the first failure. Any command naming a repository path absent from the base is skipped (`skipped: tests what the order creates`). The scratch checkout is removed afterwards; a cleanup failure is reported as `warn`, never `hold`. Fix: the failing command, its exit code and the last 20 output lines. Unlike the rest of Alba, which starts programs without a shell, these commands run through the platform shell because they are command lines a person wrote into the order; turn `run_checks` on only for projects whose orders you trust.

Configure preflight under `orders.preflight` (`mode: hold | warn | off`, default `hold`). To bypass a preflight hold for the current order file only, run `alba orders act <TAG> queue --override --note "<why>"` with a note of at least 10 characters; this records `preflight-overridden` (`{ hash, note }`) without adding a duplicate `queue` action on an already-queued order, and editing the order file changes its SHA-256 hash so preflight checks it again.

##  report delivery and approval updates

A malformed or missing final report block is sent back once with a repair prompt and recorded as `report-bounced`; the repair prompt asks the same worker/session to inspect its existing work and print only the report block. A second invalid delivery follows the normal failure path.

Approving a failed, blocked, or idle order requires `--override` and a note of at least 10 characters. The override is recorded in the action ledger; the console provides a separate override button.


## Planned work before the queue

`planned` stores a tag, title, kind, optional role, dependencies and a short intent. It has no work-order file. Cancellation is available; queueing and starting a run are refused until a producer draft is accepted. Planned work does not consume dispatch capacity and appears in the board's Planned column, with its outstanding dependencies.

```sh
alba orders plan NEXT --title "Document the result" --kind docs --needs BASEA,BASEB --intent "Explain the merged results and how to use them."
alba orders edit-plan NEXT --intent "Also explain the limitations."
alba orders cancel NEXT
```

`orders plan` with the tag of an order that is only listed (stage `draft`: no work-order file, never queued or run) turns that order into a plan in place; an empty `--title` keeps its title and omitted `--needs` keep its dependencies. Orders past the draft stage are refused.

`--role` selects a configured execution role for the plan; see [role resolution](../workers/012-routing-and-skills.md#routing-worker-groups-and-routes). Create plans with `POST /api/orders/plan` (`project`, `tag`, `title`, `kind`, `needs`, `intent`, optional `role`). Edit through `POST /api/orders/:tag/plan` with changed fields. The ordinary cancel action applies. A changed plan invalidates its pending draft.

`GET /api/orders/:tag/draft` returns the latest draft action and its preview. `POST` to the same path takes `project`, `actionId`, and `decision: save|accept|reject`; `save` also takes the Markdown `body`. The order page reuses the order body editor, saves the draft durably and refreshes the preview before acceptance. Accept creates `<TAG>-<slug>.md`, records `draft-accepted`, and queues the order. Repeated acceptance does not duplicate the file or action. Existing different files are refused. Reject keeps the plan and draft history; editing the plan opens a new drafting case.

The same `GET` also returns the last draft session of the order (`work`: id, status, reason, start and end), `canDraftAgain` and, when it is false, `why`. A failed draft session (timed out, no result, refused result) is not a rejection: the producer tries the case again on a later pass, at most twice under the current `work_timeout_minutes` and one retry an hour (failures under an older, shorter limit do not count). After that only a person starts it: `POST /api/orders/:tag/draft-again` (`project`, optional `brief`) starts a draft session now, outside the hourly retry rule but within the daily draft allowance, and records `producer-draft-again`. It is refused with 409 while a draft waits for a decision (reject it first), while a draft session runs, when the order has no open drafting case, or when the producer is off or paused. The order page shows the last draft session with its reason and a **Draft again** button.

## Configurable Markdown queue mapping

The importer is retained. `table import`, `table render --write`, `sync` and `prompt` use the project's mapping and stored order definitions, never a hard-coded project layout. Column numbers start at one. `status_map` must map every table status to an allowed stage. Unknown statuses, duplicate tags, missing required cells and overlapping mapped columns fail before state is written. Optional `section`, `tag_pattern`, `worker_column`, `needs_column`, `needs_markers`, `base_pattern` and `kind_rules` control interpretation explicitly.

For the demonstration table in `examples/demo/plan.md`, add this section to the project configuration:

```yaml
dispatch_table:
  file: plan.md
  order_column: 1
  needs_column: 2
  status_column: 3
  worker_column: 4
  status_map: { Ready: queued }
```

`table render` without `--write` emits a separate table. Write-back checks the source fingerprint and keeps text outside the selected table. `prompt` reads the imported order's work-order file and context; it does not assume the queue's original column positions.
