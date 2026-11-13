# 021. Producer policy and automation

The optional producer converts stored facts into cases and policy-gated actions. It is disabled unless `producer.enabled: true` is set. Rules select `off`, `observe`, `propose` or `auto`; missing ordinary rules use observe. The persistent model session is separately opt-in. Pausing refuses new actions. Stored actions recheck the policy hash, case revision and current order facts before execution. An action runs in one process only: the MCP server, `alba serve`, the tick and the CLI share the action list, every change to it is made to the stored list under the state lock, and a process takes an action (`claim`) before running it, so an auto action two processes see, or a proposal clicked twice, runs once. An action whose process died while it ran it is marked failed for a person to look at, never run again by itself.

The code host and coordinator are described in [Producer host](023-producer-host.md); session engines, budgets and tools are in [Producer session](024-producer-session.md). Independent verification and guarded merging use [the acceptance pipeline](../workflow/026-acceptance-pipeline.md#accept-and-merge). Producer reports are untrusted data, and human approval remains the authority for taste and policy changes.

### Milestone goal drafting

With the design library enabled, intake follows the active milestone as well as the existing order queue. Completion-criterion targets open `target-failing` cases when out of bounds and `target-unmeasured` cases when they have neither a value nor a structured measurement. Open, unassigned gaps in the milestone's optional `systems` or its criterion targets' systems open `gap-unowned` cases.

An open order owns a goal when its body contains the target or gap id. Intake records `{order, id, offset}` matches in the resolved case facts; merged, cancelled and dropped orders do not suppress new work. Cases close when owned, passing, measured/configured, closed, or removed from the active milestone, and reopen when relevant facts warrant it. Facts carry the target's metric, bounds, value and evidence, the milestone, system, active rules and open gaps. These library texts are untrusted drafting context.

The router receives bounded goal cards; a detached draft worker receives the full facts and returns a complete order with Acceptance and the exact target/gap id in its body. The router decides whether to propose that result by id. Proposals retain the goal facts for review and revalidate that the goal remains open before creating an order. Pending goal drafts can be edited, provided their id reference and Acceptance section remain. The normal policy rule is `draft-from-goal`, default `propose`; the effective rule appears in the console and session policy. Configure it explicitly to change mode:

```yaml
producer:
  rules:
    - id: draft-from-goal
      instruction: Draft work towards active milestone goals.
      action: draft-order
      mode: propose
```

This rule governs both goal drafting actions. The existing pause and policy revision checks still apply. Goal drafting uses `producer.budgets.draft_runs_per_day`; session delivery and proposal creation share one daily goal key, avoiding double charges and duplicate idempotent proposals. Reaching the allowance prevents new goal drafting.

A real tick with zero dispatches opens one `idle-capacity` case only when some configured kind is below its cap and free memory meets the dispatch minimum. Preview ticks do not raise it. Its facts list the open goal cases and free kinds so the producer can choose a next order under the same rule and allowance. The bilingual producer analysis page displays goal cards and their facts; proposal cards retain the drafting context.

Measurement execution, schedules and migration are documented in [the design library](../libraries/027-design-library.md#structured-target-measurements).


### Escalating hard work

`reroute` changes the worker for an order's next run. It requires `target` (order tag), `worker` (exact workers-file id) and a non-empty `note` of at most 2,000 characters explaining why and what to do differently. The host atomically stores a sticky `order.next_worker`, a pending note and a reroute history entry. Failed and blocked orders, and failed deliveries awaiting review, are queued again. A running order continues; its next run uses the new worker. Held, merged and cancelled orders refuse the action.

```yaml
producer:
  enabled: true
  escalate_to: [expert-worker]      # default []: refuses all reroutes
  budgets:
    escalations_per_day: 4          # default 4; UTC day
  rules:
    - id: escalate-hard
      action: reroute
      mode: propose                # default when no reroute rule is configured
      instruction: >-
        Consider a stronger worker for diagnosis, structural change, design
        trade-offs or a behaviour gate when repeated attempts make no progress.
        Explain a different approach rather than another symptom patch.
```

The default `escalate-hard` instruction asks the router to judge three consecutive failed/blocked/no-report attempts, an open loop finding, the same named gate failing in two of the last three reports, or at least three recent reworks. Reworks count within the last five attempts and after the last approval; capacity and cancelled endings break the failure streak. Active, monitoring and ready-for-review orders do not open repeated-failure cases. Order cards expose recorded `kind`, `worker`, `runs`, `consecutive_failures`, `reworks`, `loops` and `same_gate_failing` facts. These are evidence for a judgement, not an automatic model-strength classifier. Gate facts require an explicit report label such as `Gate behaviour failed`. The router selects only from `producer.escalate_to`; list entries refer to configured workers and do not add capabilities. Allowlist edits are rechecked at execution without invalidating unrelated pending proposals. `propose` waits for a person; an explicit `auto` rule runs after the guards pass.

```json
{"actions":[{"case":"failed/SAMPLE","kind":"reroute","target":"SAMPLE","worker":"expert-worker","note":"Reproduce the gate failure and redesign the state transition before changing symptoms."}]}
```

The gate refuses unknown, disabled, same-current-worker, over-spend-cap or capability-ineligible workers. It checks the resolved role's exact `requires`, including when a worker is explicitly named. Only one producer reroute per order is allowed in a rolling 24 hours; returning to any worker left within that period is refused. The daily budget counts successful producer reroutes, across orders, and is rechecked inside the order-store transaction. A person can change the order's worker or explicitly supply a different start worker to clear the pin. An API start without a worker uses the live pin before cached routing; an unfit or disabled pin is dropped with its configuration reason, preserving the person's worker hint. Dispatch rechecks capability, quota, concurrency, daily-run and spend limits; a full target leaves the order queued and never falls back to another worker.

The first run after the change starts a fresh session and appends a host-built `Previous attempts` section, bounded to 6,000 characters: run/worker counts, the last three report statuses and summaries, open loop findings, latest three rework notes and the branch head. Reports and notes remain untrusted facts; no transcript is copied. The actual launch brief is retained on the run. Later runs keep the worker pin without repeating the section. The order page shows the change, note and brief; the board shows the next worker; Activity records `rerouted SAMPLE from steady-worker to expert-worker: reason` and today's escalation budget.

The focused fixture tests are in `test/producer-reroute.test.ts`; `test/producer-reroute.test.ts` validates the same guards with synthetic state, without a model call.

### Tool calls

`tool-call` runs an operation of an enabled tool plugin without a worker: concept images for a design decision, a price before an
order is written, sound variants for a pick. `producer_read` kind `tools` lists the operations and the latest jobs; the action carries
`tool: { id, operation, input }` and, for a paid operation, `target` (the order whose quote it spends). Its default mode is `propose`.
Accepted, it starts a tool job in its own process; a paid job waits for a person to approve its quote unless `plugins.auto_approve`
covers it. See [031. Tool plugins](../workers/031-tool-plugins.md#the-producers-tool-call).

### Delivery lint

Optional mechanical checks under `checks:` run on every ready delivery before it is exposed for review; see [009](../workflow/009-checks-and-waiting.md). The `lint-bounce` action uses the existing producer policy and stored action ledger:

```yaml
producer:
  enabled: true
  rules:
    - id: delivery-lint
      action: lint-bounce
      instruction: Send deliveries with mechanical lint failures back for repair.
      mode: observe
```

Without a matching rule, the mode is `observe`. `off` refuses the action; `observe` records a would-do action; `propose` creates a console proposal card; `auto` immediately records a `rework` action and queues the order. A proposed card uses the same rework operation when a person applies it. Pause, policy-version changes and stale case facts are enforced by the existing action gate. Lint needs no model call, session turn, review run or producer turn budget.

The rework note lists each failed check, what was found and how to fix it. The note becomes part of the next worker prompt. After two consecutive lint send-backs, further failing deliveries stay in `awaiting-review` with their findings and a producer case explaining the limit. A delivery that passes lint, or a human rework, resets the streak. Repeated processing of the same delivery does not create duplicate proposals or rework actions. Findings remain visible above the report, and the board marks orders sent back by lint.

## Trust is measured

The implemented trust ladder records every new proposal, including observe-mode `would-do`, in `_producer-trust.json`, grouped by rule. Each record retains its case revision, target order, originating run, proposal text, initial order sequence and expiry. A console acceptance records `accepted` or `edited`; rejection records `rejected`. Otherwise the next matching human order event within the outcome window records agreement, an edited action, or `different` with the actual action and event reference. Producer/tick/serve actions never count as human agreement. A new run belongs to a new case; unrelated orders and explicitly different cases/runs are ignored. Unresolved records expire as `nothing`.

For an `answer` proposal, your own `alba answer` (or the console's answer action) to the same question is the decision: the same text counts as `accepted`, other text as `edited`, and another action on the order (hold, rework, cancel) as `different`. `edited` is decided but is not agreement, so a rule such as `answer-workers` reaches `auto` only through answers that match the proposal. Accepting an answer card runs `alba answer` itself: the answer is recorded and the session of the run that asked continues on the same worker when the engine can resume (otherwise a new run starts with the answer), under the same limits as a tick; when it cannot start now, the answer stays recorded and the next tick starts it. Before, the card only recorded the answer and the tick could start another worker in a new session.

The rate is exact acceptances divided by decided cases (accepted, edited, rejected, different). Pending and nothing remain visible but do not affect the rate. Rewording a proposal cannot manufacture samples: only the latest proposal per rule/case/revision/target contributes to the displayed case counts. The rolling window uses decision time, or proposal time while pending. With fewer than the configured minimum, the page says **not enough cases**. Defaults are ten cases in fourteen days, raise at or above 90%, lower below 60%:

```yaml
producer:
  trust:
    window_days: 14
    outcome_hours: 72
    min_cases: 10
    raise_rate: 0.90
    lower_rate: 0.60
```

Raising suggests observe → propose or propose → auto. Lowering suggests auto → propose, propose → observe, or observe → off. The card names the rule and shows its replacement `mode:` YAML line. These are suggestions for a person to apply; alba never writes project configuration. Recent disagreements link to the case and target order. Numeric thresholds are validated, and lower_rate must be below raise_rate. [The deterministic validation fixture](../../test/producer-briefs.test.ts) demonstrates an eleven-of-twelve raise suggestion and a three-case insufficient sample.

## Cost

The router receives compact cards; full drafting and delivery inspection run in detached sessions with their own state folders, read-only tools, timeout and strict final block. Work is recovered using PID plus start time and returns a compact card for a router decision. Drafts consume the existing daily draft allowance; reviews and other work share the review allowance with independent checks. Activity nests each run under its case with worker, duration, tokens and result.

Delivery reviews may follow skills from the registry: `producer.review_skills: [alba-review-bar]` puts the text of each named skill (front matter removed) into the review session's system prompt, after its task. `alba-review-bar` is Alba's store bar and the ways deliveries cheat (see [012](../workers/012-routing-and-skills.md#albas-skill-library)); a project may name its own review skill instead. A name the registry does not have is said in the prompt, and the review notes it.

`producer.session.wake_triggers` wakes immediately; `notice_triggers` stores low-priority cases for the next wake or `notice_max_minutes` (default 120). Default notices are gap-unowned, target-unmeasured, idle-capacity and commit-reminder. `send_triggers` remains a wake alias. Events received during a turn collapse to the latest revision and arrive in one next message, ordered by priority.

The shared per-project UTC day budget records uncached input, cache reads, cache writes and output for router and work requests. `usage_per_day` counts uncached input + cache write + output + cache read × `cache_read_weight` (default 0.1). Optional `cost_per_day_usd` uses configured per-model USD-per-million prices; unpriced tokens remain explicit. Warn at 80%, pause new work at 100%. Activity shows the breakdown and today's cache hit rate. Old budget totals remain spent without inventing category history. See [configuration and recovery](024-producer-session.md) and the [fake-engine scripted day](../../test/producer-router.test.ts).

## Planned-order drafting

When all needs of a planned order are merged, intake creates a durable `ready-to-draft` case. The optional `free-slot` setting also requires available kind capacity and a worker that routing can select. The default is `needs-merged`.

```yaml
drafting:
  when: free-slot
  template: draft-template.md
  examples: 3
  auto_kinds: [docs]
producer:
  enabled: true
  budgets:
    draft_runs_per_day: 4
  session:
    enabled: true
  rules:
    - id: draft-planned-work
      action: draft-order
      instruction: Draft the planned work using the supplied context and template.
      mode: propose
```

The template path is relative to the project configuration file. It supplies section headings and standing hard rules. Without one, headings cover Background, Files to read, Task, Acceptance, Evidence and Hard rules. `examples` defaults to 3 and accepts 0 to 20 accepted bodies of the same kind. The context includes intent, needed orders' reports, acceptance notes and relevant events, standing direction, and those examples. Roles are stored on plans and resolved through the configured [execution roles](../workers/012-routing-and-skills.md#roles) at dispatch.

The detached draft session receives the complete drafting context; the persistent router receives only the compact case and result id. `producer_read` with `kind: drafting` and `tag` remains available for paging detail. The router proposes `draft-order` by work id; the host retrieves the full order containing tag, title, kind, needs, body and optional worker hint. Title, kind and needs must preserve the plan, and a body needs `## Acceptance`. Starting one detached run consumes one daily draft allowance, with an idempotent receipt shared with proposal creation. The allowance persists across restarts and resets at UTC midnight. Cards held by the allowance remain eligible; include `ready-to-draft` when overriding `session.wake_triggers` (or its legacy `send_triggers` alias).

The order page shows the complete body, independent rule classifier kind, normal routing's worker choice, resource pattern matches with highlighted words, and concrete paths absent from the configured local base branch. Resource matching shares dispatch's title, condition and first 4,000 body characters. Path checking reads Git's base tree, including directories; URLs and globs are excluded. Previewing starts no worker and takes no leases.

Accept, save and reject are durable decisions. Acceptance rechecks the current policy, case, plan fingerprint and merged needs. `auto` only applies when the rule is auto **and** the planned kind is in `drafting.auto_kinds`; other kinds remain proposals. Automatic drafts use the same file creation and queue action and remain in the producer log. A rejected draft is not regenerated until its plan changes. See [the fake-engine validation](../../test/planned-drafting.test.ts).

## Scheduled briefs

```yaml
producer:
  brief:
    every_minutes: 60
    daily_at: "09:00"       # optional additional daily trigger, UTC
    language: zh            # deterministic English/Chinese skeletons
    command: [notify-tool, --stdin] # optional executable and argv; no shell
```

The serve coordinator checks the schedule every thirty seconds, also after real ticks. A missing brief configuration disables scheduling. The first eligible pass emits a brief; subsequent passes run at the interval or the additional daily boundary. Disabled or paused producers emit nothing. Due times survive restart through stored brief timestamps; hooks are not replayed on restart.

Code builds the skeleton from the stored L1/L2 fact snapshot, event log, current orders, pending producer proposals and the latest real tick's activity/dispatch readings. The standing direction comes from the same reader as chat. Sections cover changes (merged, delivered, sent back, failed, dispatched, held), running orders and minutes since last commit, stalled orders, free cap slots and dispatch blockers, cards/questions/holds older than three days, the constraint, and new or recurring risks. Initial changes cover the preceding day. Later changes start strictly after the previous brief. Counts describe recorded events, not inferred successful deliveries. Missing readings and commit times remain unavailable.

Each brief stores a deterministic skeleton, final text, immutable numeric fact ledger with event/git/tick references, the input snapshot and standing direction. Every numeric claim cites a fact or event. When the relevant events and operational state have not changed, it is one line. Briefs retain the newest two hundred records in `_producer-briefs.json`; the page lists the newest fifty first, with expandable evidence. `GET /api/p/<project>/producer/insights` reads stored trust and brief state without scanning orders/events or invoking a model.

When an enabled session is already idle and has budget, it may rewrite the skeleton in the configured language. Otherwise code stores the skeleton. The validator requires the exact multiset of numeric tokens and the exact set of citations; changed or missing values/citations discard the prose. Hook argv comes only from configuration, with `shell: false`; UTF-8 text goes on stdin and never on the command line. The brief is stored before the hook; failures are visible and do not erase it. A pending hook after a crash means delivery is unknown and is not retried automatically.

## Scheduled round and actions

```yaml
producer:
  enabled: true
  round: { every_minutes: 60, enabled: true }
  session: { enabled: true, notes_chars: 8000 }
  rules:
    - { id: start-next, action: dispatch, mode: propose, instruction: Start the next eligible order. }
    - { id: free-disk, action: clean, mode: propose, instruction: Review the stored cleanup plan. }
monitor: { stale_minutes: 45 }
```

The round is off when absent. Serve checks due times every thirty seconds and persists the last completed round. Disabled/paused producers do nothing. A due round reads compact `status` plus deterministic stall, process identity, monitor output/file, dispatch, failure and disk facts. Only stalled runs, stale monitors, eligible next work (or its drafting case), repeated failures and low-disk/cleanup-gain cases go to the session. A quiet hour costs no model tokens. Its checked categories, status and attention summary are stored with `kind: round` in the existing brief history; ordinary brief scheduling remains independent.

Round cases use stable evidence keys. Elapsed-time labels and new check timestamps alone do not create a revision, model resend or second action. Changed facts revise the case; resolved attention closes it. Existing event cases retain their own lifecycle. Default round actions are proposed `dispatch`, stale-monitor `rework` with an evidence note, and proposed `clean` with an immutable dry-run plan. Explicit rules use the ordinary off/observe/propose/auto policy, pause, revision and acceptance gates. Dispatch rechecks current capacity and all launch blockers; cleanup rechecks every target and applies only the accepted plan. See [tick dispatch](../workflow/004-tick.md#producer-dispatch), [monitor identity and loop refusal](../workers/014-monitor-leases-loops.md#stale-monitors-and-repeated-producer-retries) and [cleanup retention](../workflow/011-decisions-questions-evidence-clean-credits-lessons.md#clean).

`producer_notes` accepts `tag` for separate per-order facts; omitted means project notes. The default project window is 8,000 characters, configurable with `producer.session.notes_chars`. Old overflow and replaced project text are appended to dated state archives rather than lost. Producer Analysis shows project/order notes, drive readings and last clean; order details show project notes beside that order's notes. [The reproducible fixture tests](../../test/producer-round.test.ts) covers quiet rounds, each attention trigger, refusal gates and accepted cleanup without a real model.

## Activity and daily digest

The Producer page has Conversation, Analysis and Activity tabs. With no pending question, direction change or actionable proposal, Activity opens by default. An explicit `?tab=activity` link always opens it. The project overview's Producer card shows the same session status line and latest five visible events.

Activity polls stored state every five seconds. The session status line shows the session's active case/order, last turn, next configured round and five budget readings, plus today's input/cache read/cache write/output breakdown, cache hit rate and priced/unpriced usage. Missing historical fields say **Not recorded**. Review usage combines independent checks and producer review/work runs. Budget windows reset in UTC. The timeline groups timestamps by the browser's local day, newest first, and includes actions, case/work child rows, pause/resume, session lifecycle and budget events. Filter by kind, order, status or autonomous execution; superseded actions are initially hidden. Each pass expires proposals whose order stage, run or action sequence changed, and goal/cleanup proposals whose case closed.

Expand a row for its full note, evidence, recorded policy rule/version and, for accepts, the merge commit and design change-set step when recorded in the execution window. A **claim** badge marks verification language in accept/rework notes, including English and Chinese wording. It invites inspection and makes no judgement about truth or quality.

`alba producer log --since 2026-06-17T00:00:00Z` prints one line per visible event; add `--json` for the shared read model. Neither the command nor `GET /api/producer/log` performs intake, reconciliation, model calls or actions. See [the API contract](../console/010-api.md).
