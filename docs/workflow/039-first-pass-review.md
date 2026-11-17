# 039. First-pass review

Uses the terms of [006. Review](006-review.md), [026. Acceptance pipeline](026-acceptance-pipeline.md) and [037. Capture recipes](037-capture-recipes.md).

A ready delivery can pass mechanical checks and still miss an acceptance requirement or show the wrong screen in its captures. First-pass review runs a read-only worker from a different `model_family` than the delivering worker before a person reviews the order, giving the reviewer the acceptance list, diff stat, report, final message and any trial captures.

## Configuration and modes

```yaml
review:
  mode: auto                 # plain `review: auto | manual` keeps working everywhere
  first_pass: advise         # off (default) | advise | bounce
  first_pass_kinds: [visual] # optional: only these routed kinds; default all kinds
  first_pass_minutes: 30     # running reviews past this deadline are stopped and recorded as unsure
roles:
  first-pass:                # optional; without it, roles.verifier is used when present
    workers:
      prefer: [claude-reviewer, codex-reviewer]
producer:
  budgets:
    review_runs_per_day: 8   # shared with independent checks and producer review sessions
```

`ProjectConfig.review` retains `'manual' | 'auto'`; the mapping form sets `mode` alongside `first_pass`, `first_pass_kinds` and `first_pass_minutes` (default `30`). Invalid keys or values fail naming the configuration key.

Modes:

- `off` (default): no first-pass review is started.
- `advise`: the verdict appears on the review card and in `producer_read` (`kind: "order"`), without changing order stage or queueing rework.
- `bounce`: a `send-back` verdict with `confident: true` automatically sends the order back once via `rework`, subject to the bounce guards below. `pass`, `unsure` and unapplied send-backs stay in `awaiting-review` for the lead.

## Eligibility and reviewer choice

`runFirstPass` runs once per real tick right after `runAcceptanceTrials`. It polls open first-pass runs first, then starts at most one review per order when:

- `review.first_pass` is `advise` or `bounce`;
- the order's effective kind (`routingOf(project, doc).kind || doc.order.kind`) matches `first_pass_kinds` when configured;
- the order's stage is `awaiting-review`, its latest report is `ready`, no delivery run is open, delivery lint is not failing, and any acceptance trial for the current report is not `waiting`;
- no `first-pass` record exists yet for `(commit, report, acceptance, delivering_worker)`.

Reviewer selection resolves `roles.first-pass` when defined (falling back to `roles.verifier`, else any eligible worker) and filters the candidate pool to read-only-capable engines (`codex-cli` and `claude-cli`), dropping:

- the delivering worker;
- any worker with the delivering worker's `model_family` (case-insensitive);
- any worker whose configured model equals the model used by the delivering run (including `--run-model`);
- any worker without `model_family`;
- any engine without a read-only verifier launcher.

If the delivering worker has no `model_family`, the run is recorded as `skipped` with `set model_family on <worker> to allow a first pass`. If no eligible cross-family reviewer can be chosen, or `producer.budgets.review_runs_per_day` is exhausted (shared with [independent checks](026-acceptance-pipeline.md#accept-and-merge)), the run is recorded as `skipped` with the reason. First passes never replace delivery runs or reports.

## Checkout layout, inputs and timeout

Each review creates a detached Git worktree at `<state_dir>/first-pass/<id>/checkout` on the delivery commit and writes its inputs into `checkout/.alba-first-pass/`:

- `acceptance.md` — the order's `## Acceptance` section;
- `diffstat.txt` — `git diff --stat <base>...<commit>` (at most 200 lines);
- `report.json` — the ready report record;
- `final-message.txt` — the worker's final delivery text (at most 20,000 characters);
- `capture/manifest.json`, `capture/sheet.png` and every `<shot>.png` when the latest acceptance trial for this report ran a `capture` step (plus `targets.json` when target results are present on the trial).

Placing `.alba-first-pass/` inside `checkout` keeps every text file and PNG inside the reviewer's working directory for both `claude-cli` (`Read,Glob,Grep`) and `codex-cli` (`--sandbox read-only` and `view_image`), with every path listed explicitly in the prompt. No edits, builds or worker contact are permitted; inputs are marked untrusted data. When the process exits, Alba verifies that `HEAD` still equals the delivery commit and `git status --porcelain --untracked-files=all -- . ":(exclude).alba-first-pass"` is empty before removing the worktree; any modification outside `.alba-first-pass/` invalidates the run as `unsure`.

A review still running after `first_pass_minutes` has its verified process tree stopped via `stopProcessTree` and is recorded as `done` with verdict `unsure` and reason `timed out`.

## Verdict block

The reviewer ends its final message with:

```text
--- alba-first-pass ---
{"verdict":"send-back","confident":true,"items":[{"item":"...","verdict":"fail","evidence":"night.png shows the menu"}],
 "note":"what to fix, concretely","summary":"one line"}
--- end ---
```

`parseFirstPassVerdict` requires an explicit `--- alba-first-pass --- ... --- end ---` block whose JSON has:

- `verdict`: `'pass'`, `'send-back'` or `'unsure'`;
- `confident`: boolean (`true` only when a failed item is directly shown by inspected evidence that a person would agree with unchecked);
- `items`: nonempty array of `{ item, verdict: 'pass' | 'fail' | 'doubt', evidence }` with nonempty strings;
- `summary`: nonempty string;
- for `pass`: every item must have `verdict: 'pass'`;
- for `send-back`: at least one item must have `verdict: 'fail'` and `note` must be at least 40 trimmed characters.

Any missing, malformed or contradictory block is recorded as `unsure` (`summary: "invalid verdict"`).

## Bounce rules and events

In `bounce` mode, a completed `send-back` with `confident: true` calls `rework(orders, tag, note, { max: dispatch.max_reworks })` with a note starting `First-pass review by <worker> (<model_family>): <note>`, sets `applied: true`, and records `first-pass-applied` `{ id, report, action }`.

A send-back is **not** applied (`not_applied` records the reason on the `first-pass` event) when:

- `confident` is `false`;
- the order is `held`;
- `reviewOf(project, order)` is `manual`;
- the order left `awaiting-review`, received a newer report, or already has an action after the reviewed report (`superseded`);
- this report was already bounced;
- the previous send-back on the order was itself a first-pass bounce (never two automatic bounces in a row);
- `dispatch.max_reworks` has been reached.

Recorded events:

- `first-pass` (folded to the latest record per `id`): `{ id, tag, report, fingerprint, commit, worker, model_family, delivering_worker, delivering_family, status: 'running' | 'done' | 'skipped', started, ended?, verdict?, applied?, not_applied?, reason? }`;
- `first-pass-applied`: `{ id, report, action }`;
- `first-pass-disputed`: `{ id, report, worker?, model_family?, note }`.

On the console's review card (`FirstPassVerdict`), Alba shows the verdict, reviewer and model family, per-item evidence, note, whether the send-back was applied or why not, and a **Wrong send-back** button (`POST /api/orders/<TAG>/first-pass-wrong` or `alba review <TAG> first-pass-wrong --note <text>`, requiring at least 10 characters). `OrderDetail.firstPass` and `producer_read` (`kind: "order"`) carry the latest first-pass record for the current report.

## Agreement statistics and when to trust it

```sh
alba review stats [--days 30] [--json]
alba review <TAG> first-pass-wrong --note "Explain why the bounce was wrong"
```

`alba review stats` and `GET /api/review/stats?project=&days=` compute agreement directly from stored events and order actions over the window (default 30 days). The lead's decision on a reviewed report is the first `approve`, `rework`, `cancel` or `drop` action on that report, excluding the automatic bounce action itself:

- **Agree**: `pass` followed by `approve`, or `send-back` followed by `rework`.
- **Disagree**: `pass` followed by `rework`/`cancel`/`drop`, or `send-back` followed by `approve`/`cancel`/`drop`.
- **Unsure**: counted separately in `unsure`.

Per reviewer `model_family` and routed `kind`, Alba reports `verdicts`, `decided`, `agree`, `disagree`, `rate`, `unsure`, `applied`, `disputed`, and median minutes from report to verdict and from verdict to decision. Under 10 decided cases, the rate reads `not enough cases` (mirroring [producer trust](../producer/021-producer.md#trust-is-measured)).

Start in `advise` mode first so every verdict is compared against human review decisions without delaying valid deliveries. Move to `bounce` (or scope with `first_pass_kinds`) only once a reviewer `model_family`'s agreement rate holds over at least 10 decided cases and disputed bounces stay rare.

See [first-pass validation](../../test/first-pass.test.ts) and [agreement statistics validation](../../test/first-pass-stats.test.ts).
