# Decisions, questions, evidence, clean, credits and lessons

Six helpers around the order engine. Each is optional, each is switched on by a section of `alba.yaml` (or by being used), and each has a command, a JSON call and, where it makes sense, an event on the stream (docs/console/010-api.md has the calls and shapes).

## What a person is waited for: card or answer

An order in `awaiting-user` is waiting for one of two things, and the interface says which (`waitingFor`):

- `answer`: a worker asked a question (a report with status `waiting` and a `question`). `alba answer` / the `answer` action reply to it; the worker's own session continues when its engine can.
- `card`: a person has to open a session of their own and click the card the worker could not start by itself. There is nothing to answer, so `answer` is refused (409); a person clicks the card, or sends the order back with a rework note.

A worker says which in its report block: `"waiting_for":"card"` or `"answer"` (no word means `answer`). When a project's Markdown dispatch table is imported, the status word decides: words listed in `dispatch_table.card_words` (a subset of the words `status_map` maps to `awaiting-user`) mean `card`, every other `awaiting-user` word means `answer`. A `blocked` order is always waiting for an answer.

`approve` is offered by the interface only for an order that is `awaiting-review` (the command line is more lenient for an order that is `idle`).

## Decisions ledger

A ledger of the decisions a project has taken, so that a work order can say "follow D2031" and a reviewer can look it up.

```yaml
decisions:
  file: ../notes/decisions.md      # optional: a Markdown table that is read in (never changed)
  section: Decisions               # optional: the table under the first heading that contains this
  id_column: 1                     # 1-based; the cell holds D2031 or 2031
  date_column: 2
  text_column: 3
  source_column: 4                 # the user's words, or the note that it was a default
  id_prefix: D                     # up to 4 letters; default D
  reviewer_range: [2030, 2059]     # the numbers a reviewer hands out
  # store: decisions.jsonl         # the entries made here (default: <state_dir>/decisions.jsonl)
```

`alba decide "Two players, local" --source "\"two players is enough\""` records a decision with the user's words; `--default` records one taken without them (the source then says so). `alba decisions` lists the ledger, the next number and the ranges reserved on open orders. Every entry has an id (`D2031`), a date, the text, the source, who recorded it and when. An entry made here wins over a table row with the same number. `section: "*"` reads every table of the file, each entry with the heading above its table as its topic, and `alba decisions --check` lists numbers that appear twice (document 013).

Numbers: a new decision gets the lowest free number of the reviewer's range (without one: one above the highest). A worker's range is written on its order, in the `decisions` text of the mandate (`D2100-D2110`); `alba decide --order TAG` takes the next number of that range, and nothing else may use a number inside the range of an open order (merged and cancelled orders release theirs). An id that is taken, that is inside another open order's range (409), or outside the reviewer's range is refused.

An order's detail shows the ledger entries it names (`referencedDecisions`): ids in its title, condition, mandate or work-order file.

## Questions with options

`alba ask TAG --text "Which palette?" --option "Warm | the mockup | art/warm.png" --option "Cold"`: 2 to 4 options, the recommended one first, each with an optional note and image files. The order goes to `awaiting-user` with the question and its options in a waiting report. `alba pick TAG Q1 --choice 2 --note "..." --who Sam` (or `POST /api/orders/:tag/questions/:id/answer`) picks one: the question records who chose, through which channel, when and the note; the order goes back to `queued` with the choice as the instruction for the next run, like any answer. A worker can also put options in its own report block (`"options":["Warm",{"label":"Cold","note":"..."}]`, with a `question`); `alba answer TAG --choice 2 [--text note]` picks one of those. Option images must be image files the interface may read (see Evidence) and are shown as thumbnails.

## Evidence

What an order delivered as pictures and videos, in one place: files named in its reports' `evidence` list, files in the project's evidence folders, and the images of its questions.

```yaml
evidence:
  dirs: ["artifacts/evidence/{tag}"]    # relative: looked for in the order's worktree, then in the project
```

`GET /api/orders/:tag/evidence` lists them with size, modified time and, for png, jpeg and gif, the pixel size. `GET /api/files?path=&tag=` sends one file (`Range` supported, so videos seek). It is read-only and confined: the file's real location (links and junctions followed) must be inside the project, its work-order or state folder, one of its worktrees or an evidence folder, and only images and videos are sent (png, jpg, gif, webp, bmp, mp4, webm, mov). Nothing else can be read through it, and nothing can be written.

## Clean

`alba clean` shows what it would remove; `alba clean --apply` does it. The clean-plan API stays read-only; a stored producer `clean` proposal can be accepted through the producer action API.

```yaml
clean:
  idle_hours: 24                  # a merged worktree must have been quiet this long
  caches: ["Library", ".godot"]   # folders removed from worktrees whose work is not merged yet
  builds: [{ dir: artifacts/builds, keep: 3 }]   # only the newest 3 build folders stay
  packages: [{ dir: artifacts/packages, keep: 2, links_from: [artifacts/launchers] }]
  logs_days: 14                  # old .log and .events.jsonl under state/runs
  drives: [{ path: ".", min_free_gb: 20 }]
  min_gain_gb: 1                # default; strict greater-than threshold
  auto_classes: [caches, logs]  # only these classes may use an auto clean rule
  auto_destructive: false     # true also permits worktrees/packages in auto_classes
  snapshot_entries: 100000    # full artifact metadata snapshot limit per item
  snapshot_seconds: 5         # full artifact snapshot time limit per item
  busy_processes: ["Godot", "dotnet"]            # nothing is deleted while one of these runs
```

- A worktree whose order is merged or cancelled, whose branch is in the base branch, that has no uncommitted file and has been quiet for `idle_hours` is removed with its branch (`git worktree remove`, then `git branch -d`; a branch git will not delete is kept and the result says so).
- A worktree whose work is not merged keeps everything except the `caches` folders.
- Build folders keep the newest `keep`.
- Open runs and unresolved monitors protect their owning worktrees, packages and builds. Ended runs and resolved monitors do not veto. A live PID must match its recorded OS creation time within one second; legacy records without that time require a process created since the run began (with the same precision tolerance). A mismatch says `pid N belongs to another process`. Unreadable creation times keep the owner's artifacts conservatively.
- Packages and builds also stay while a running process has an executable inside the folder, or executable paths cannot be read. An unrelated order's run does not block them. Logs stay only for their own open run. Configured busy programs, or failure to read their list, still veto deletion project-wide.
- Links (symbolic links and junctions) are removed before anything is deleted, so a delete never follows a link out of the folder.
- Every action leaves a `clean` event and a `result` on its item. Without `--apply` nothing is changed, not even a file time.

Package and build folders are matched to an order by an exact tag or a tag followed by `-` or `_` (the longest matching tag wins). Newest-N retention uses folder modification time. Unknown package owners, unmerged orders and deliveries awaiting review are always kept, even beyond N. Run-log retention only scans regular `.log`/`.events.jsonl` files directly under `state/runs`; an open run keeps its logs. Builds/packages containing tracked or uncommitted files are skipped. Whole base checkouts, nested worktrees and linked ancestors are never removed. Cache pruning also refuses tracked targets.

`packages[].dir` can be relative to the project or an absolute folder on another drive. A package retention root must not be a drive root, the project root or its ancestor, or traverse a symbolic link/junction; this is checked again when applying. External packages inside another Git checkout are retained. All owner, keep-N, review and process checks still apply outside the project. Optional `packages[].links_from` lists folders (relative to the project or absolute) whose immediate links are checked after successful package deletion. Only a link whose resolved lexical destination is exactly the removed package folder is unlinked, including a dangling link. Regular files, links to other packages or subfolders, nested entries and linked scanning folders remain untouched.

The scheduled producer round opens a `clean` case when a configured drive is below its minimum or eligible known bytes exceed `min_gain_gb` (default 1 GB). Drive probe failures remain visible as unknown. Every dry-run item shows its path class (`worktrees`, `caches`, `builds`, `packages`, `logs`), bytes where known, action and reason. The default action mode is `propose`. An auto rule additionally needs every selected class in `clean.auto_classes`. By default only caches, logs and builds may be allowlisted; `clean.auto_destructive: true` explicitly enables worktrees and packages too. The flag alone does not allowlist anything. Automatic removal uses the same fresh safety checks as accepting a proposal: clean, idle, merged/cancelled worktrees with branches in base; merged package owners, keep-N, review status and executable/process checks.

Acceptance uses the stored plan, never adds newly discovered targets, and rechecks every selected item before deleting any. Changed safety facts, ownership or retention eligibility refuse the whole stale plan.

Worktree removal fingerprints the HEAD commit, current branch, an empty `git status --porcelain --untracked-files=all`, and a shallow metadata snapshot of the root and its top two levels. Ignored engine files are expected: their full contents are not walked for the fingerprint, and deeper ignored file contents are outside the snapshot. The same Git and shallow metadata checks run again at apply time. Link/junction entries in the snapshot record their path and destination without following them. Before `git worktree remove --force`, `findLinks` scans all levels without following links and every discovered link is unlinked first, including links deeper than the snapshot.

Build, package and cache-prune targets retain full recursive metadata snapshots. `snapshot_entries` (a positive whole number, default 100000) and `snapshot_seconds` (a positive finite number, default 5) bound each full snapshot; exceeding either limit skips the item with the cause shown. These budgets do not limit the shallow worktree fingerprint. Links are recorded without following them and unlinked before deleting their containing tree. A linked ancestor above any target still refuses. Applied items retain results and emit `clean` events; the Producer Analysis tab shows current drive free space and the last applied plan. See [the temporary-project fixture](../../test/producer-round.test.ts).

## Credits approval

For paid resources (generated images, model calls): the worker asks, a person decides, and the worker may spend only inside the approved cap.

1. `alba credits quote TAG --service "image generation" --cap 40 [--unit credits] [--unit-price 2 --quantity 20]` makes a quote, status `pending`.
2. A person approves it with a cap of their own on the board (or `alba credits approve TAG C1 --cap 30`), or rejects it.
3. Before each paid call the worker runs `alba credits gate TAG C1 --need 4 --key call-7`: exit 0 when the quote is approved and has at least 4 left, exit 1 (and a reason) otherwise. The worker does not go on when it exits 1. A gate that passes holds the 4 under the key (one is made up and printed when `--key` is not given) for an hour, so two calls that pass the gate at the same time cannot both spend the last of the cap.
4. After the call `alba credits spend TAG C1 --amount 4 --what "4 sprites" --key call-7` books it and its hold; a booking above the cap (less what other holds keep) is refused. The same key again books nothing more (a retried command is safe); a booking without a key takes the place of the oldest holds.

Quotes are kept per unit; units are never added together. The order's detail lists its quotes with their ledgers, `spend.credits` shows approved / spent / pending per unit next to the  `spend_cap`, and the overview lists the quotes that wait for approval.

## Lessons library

Rules learned from mistakes, selected by relevance and size for each run's prompt.

```yaml
lessons:
  dir: docs/lessons
  packs: [unreal, windows-workers]
  max_bytes: 6000                     # UTF-8 bytes of the rendered section (0 = no limit)
  max_items: 15                       # mounted lessons per prompt (0 = no limit)
  level_order: [rule, checklist]      # optional: rank free-text level words highest first
  kind_tags: { ue: [engine, build] }
```

```markdown
## L012 Never hand-edit generated assets
- tags: art, ui
- priority: high
- added: 2026-11-12
- rule: Change the source file and export again; never edit the exported image.
- why: A hand edit was lost at the next export.
```

An order lists tags (`alba orders add ... --tags art,ui`, `tags` in `POST /api/orders`). Candidates for a run are the project's applicable lessons that match:
- the order's own tags, kind or classified kind (tag class 3),
- **run tags** from the chosen worker and machine (tag class 2): the worker's `engine`, that id without `-cli` (`codex-cli` -> `codex`), the worker's `model_family`, and the run machine's `os` (`windows`, `linux`, `macos`),
- tags mapped from the order's kind by `lessons.kind_tags` (tag class 1), or
- `all` (tag class 0).

`alba prompt <TAG> [--worker id]` runs the same selection for the worker shown on the order (or no run tags when it has none). `GET /api/lessons`, the order page and `alba lessons [--tag ...] [--order TAG]` keep `lessonsForOrder` (order/kind/`kind_tags`/`all` in ID order). A session resumed directly for an answer, monitor result or message carries no lessons: the conversation already holds them.

### Ranking and budget

Candidates are ranked, first difference winning: (1) `priority: must`, (2) highest matched tag class (`3 > 2 > 1 > 0`), (3) more distinct matched tags, (4) `priority` (`high > normal > low`), (5) `lessons.level_order` when configured, (6) recency (`added` date `YYYY-MM-DD`, else later position within its file), and (7) lesson ID.

Rules are cut at `max_rule_lines` (default 6) and mounted in rank order while the rendered section stays within `max_bytes` (default 6000) and `max_items` (default 15). A lesson that exceeds the remaining byte budget is skipped so smaller ranked lessons after it can still fit. Lessons with `priority: must` are always mounted; if they alone exceed `max_bytes` or `max_items`, `over_budget: true` is recorded. Setting both `max_bytes: 0` and `max_items: 0` opts out completely: every `lessonsForOrder` match is mounted in ID order with no run tags, ranking or file list.

Unmounted candidates are listed at the end of `## Lessons from earlier work` under `Also on file; read the ones that touch your work:`, one line each (`- L-ENG-07 Title (docs/lessons/engine.md)`). Paths inside the project root are written relative to the project with `/`; files outside the project use an absolute path on local runs and `(on the alba machine)` on remote runs. At most 30 lines are printed, followed by `and N more: alba lessons --order <TAG>` when more remain.

### Recording and inspection

Each launched run records `Run.lessons` (`{ mounted, listed, bytes, over_budget? }`) and `Run.prompt_bytes` (`{ rules, lessons, skills, notes, order, alba, total, file: 'prompt' | 'handoff' }`, UTF-8 bytes summing to the written file size; hand-over runs measure the `.handoff.md` continuation file), and emits a `lessons-mounted` event (`{ run, mounted, listed, bytes, over_budget? }`, with `mounted: []` on resumed continuations without lessons).

`alba orders show <TAG>` prints one breakdown line under `Runs:` for each run that has `prompt_bytes`:

```text
  r3  prompt 11.8 KB: lessons 5.9 (14 in, 32 listed) | rules 0 | skills 1.3 | notes 2.4 | order 0.1 | alba 2.1
```

### `alba lessons stats [--since 30d] [--kind k] [--json]`

Reports per-lesson outcomes across runs in the window (default `30d`; `--since all` inspects every run). Runs recorded before `Run.lessons` existed are read automatically from `## Lessons from earlier work` in their `prompt_file` when still on disk, and the header prints how many runs came from prompt files.

For each lesson, the command counts runs that carried it, how many were judged (first `approve` or `rework` before the next run, or a `brokenRun` that died without a report), and the share accepted on the first pass (`approve` with no earlier `rework` on the order; a `brokenRun` counts as not accepted), alongside the same numbers for runs **of the same kind** without that lesson, the difference in percentage points, and both sample sizes. Each row gets a plain label:
- `in every run of this kind` — nothing without it to compare against,
- `too few runs` — fewer than 5 judged runs on either side,
- `no effect visible` — absolute difference smaller than `1 / sqrt(smaller n)`, a rough noise bound rather than a significance test,
- `higher with it` or `lower with it` — difference at or above that bound.

Treat the table as descriptive correlation, never causal proof: teams add lessons *after* failures and during harder milestones, so new lessons often appear on tougher orders first.
