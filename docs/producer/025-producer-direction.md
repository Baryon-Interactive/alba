# 025. Producer facts, constraints and standing direction

The producer reads deterministic project facts and accepted standing direction. Model narration and proposed actions pass the same policy and evidence gates as other producer work.

## Flow facts

Implemented in `src/producer/facts/`. Real ticks refresh one `producer-facts` metadata snapshot, no more than once per five minutes. In serve this executes in the existing coordinator worker; standalone ticks run in their own process. `GET /api/p/<project>/producer/facts` returns `{ project, snapshot }`, with `snapshot: null` before the first real tick. It reads metadata only, without order/event scans, probes, usage collection or model calls. Facts can be older than five minutes when real ticks are disabled or less frequent; the page shows the snapshot time.

Metric definitions and deliberate choices:

- Replay document runs, reports and actions in timestamp/sequence order, supplementing missing actions from the event log. Current order kind and heavy-cap membership apply to the whole history; past classification/cap changes are not reconstructed. Dependency waiting belongs to queued. Drafts use an additional `unqueued` stage and are excluded from WIP and efficiency. Idle and non-ready report states belong to stopped, preserving the report status. Approved and cancelled orders use done, preserving their disposition; only approvals count as throughput. Holds and releases use existing stage precedence. Zero-duration boundary segments preserve state exactly at snapshot time.
- Both rolling windows (24 hours and seven days) include decisions/completions at the endpoints. Cycle time and open age start at order creation; cycle time ends at the latest approval of an order still merged. Quantiles use linear interpolation. A kind's p85 uses only orders completed in the selected window; no sample yields null. WIP is the snapshot-end count of all released, nonterminal items, including held/stopped items. Throughput divides approvals by window days. Efficiency is working time divided by all released, nonterminal stage time clipped to the window; monitoring counts as waiting.
- Slot means sample inferred working/monitoring stages on UTC ten-minute boundaries in the half-open window (144 or 1008 observations), and include a separate current reading. Kind and heavy caps share dispatch's membership rule. Idle is floored at zero; measured use is not clamped to the present cap. Historical occupancy uses today's configured cap. The cumulative-flow SVG uses 25 points per window. It shows inventory by stage, so reopened orders can move out of done.
- Cause rules live in one ordered generic regex table: capacity, environment, tool, specification, result. They inspect non-ready final report summary/question text; progress and monitoring are excluded. Ended runs without a report contribute explicit missing-report outcomes. Unknown text stays unclassified and remains listed with its tag and timestamp. No model infers causes.
- Yield/rework cohorts contain orders with an approval or rework decision in the window. First-pass yield means the first recorded decision was approval; mean rework uses lifetime rework decisions through snapshot time for that cohort. Worker attribution follows the run immediately preceding each decision. Per-worker first pass considers that worker's first decision on the order, so a replacement worker is not charged for someone else's rejection. Routing also includes workers with runs started in the window and counts those runs separately. Comparisons stay hidden until five distinct decided orders exist for that worker/kind/window.
- Acceptor latency pairs a ready report with the next approval, rework or cancellation decision in the window. A newer ready report supersedes an older ready before the same decision. Outstanding reports are not zero-latency samples.
- Merged-order costs use lifetime stored usage turns (or a run's stored total when turns are absent), without double counting the run total. Unmerged costs include tokens recorded in the window on orders currently not merged, including cancelled orders. Unknown totals stay null; unknown-order counts are also facts. Routing token/runtime medians use the completing worker's contributions on the orders it delivered for merge; hours mean worker run hours, rather than full elapsed cycle time. Partial known usage is a lower bound.
- Analysis displays the constraint, goal, flow, proposals, routing and order events. Brief history is available in the insights read model. The page initially reads only the facts snapshot; the existing rules/cases/actions/session query is deferred until Order events is unfolded. Flow defaults to seven days; both windows remain available in the API. No chart dependency is used.

Fact IDs use the following catalog, each suffixed with `.24h` or `.7d`. Dynamic components are URI encoded, including dots, to avoid collisions. Each fact includes its window, value (null when unknown), unit, and distinct supporting tags when at most twenty.

| ID prefix / metric | Unit |
|---|---|
| `F:kind.<kind>.wip`, `.tokens_unknown_orders` | orders |
| `F:kind.<kind>.throughput` | orders/day |
| `F:kind.<kind>.cycle_p50`, `.cycle_p85`, `.cycle_p95`, `.acceptor_p50`, `.acceptor_p90`, `.stage.<stage>` | hours |
| `F:kind.<kind>.efficiency`, `.first_pass_yield` | ratio |
| `F:kind.<kind>.rework_mean`, `.rework_rounds` | rounds/order, rounds |
| `F:kind.<kind>.tokens_per_merged`, `.tokens_merged`, `.tokens_not_merged` | tokens/order, tokens |
| `F:order.<tag>.age`, `.age_p85_ratio` | hours, ratio |
| `F:slot.<cap>.working`, `.monitoring`, `.idle`, `.current.<stage>`, `.cap` | slots |
| `F:slot.<cap>.samples` | samples |
| `F:cause.<cause>` | reports/outcomes |
| `F:cfd.<timestamp-ms>.<stage>` | orders |
| `F:routing.<worker>.<kind>.orders`, `.decided_orders`, `.runs` | orders, runs |
| `F:routing.<worker>.<kind>.first_pass_yield`, `.rework_mean`, `.rework_rounds` | ratio, rounds/order, rounds |
| `F:routing.<worker>.<kind>.tokens_p50`, `.hours_p50`, `.main_cause` | tokens/order, hours/order, cause |

The deterministic fixture, snapshot-only API test, and UI render test are in `test/fixtures/producer-facts.ts`, `test/producer-facts.test.ts`, and `ui/src/pages/ProducerPage.test.ts`. After `pnpm -C ui build`, setting `ALBA_FACTS_EVIDENCE=1` for `pnpm -C ui test` writes the rendered fixture HTML, snapshot and complete fact-ID list under ignored `.alba/producer-facts/`.
## Constraint selection

Each fact snapshot includes `analysis.constraint` and `analysis.risks`, computed in the same coordinator pass and saved atomically with its evidence facts. An incomplete snapshot shows a pending state until the next refresh. The facts endpoint remains a metadata-only read. The chat/MCP constraint reader takes its card from that same snapshot.

Selection uses the seven-day window. Queue share is a stage's waiting hours divided by total waiting hours across queued, monitoring, acceptor, stopped and held stages. Growth is the end inventory minus start inventory from the cumulative-flow facts. Among growing queues the largest share wins. If no queue grows, eligible threshold rules are ranked by value/threshold; low yield uses `(1 - yield) / (1 - minimum)`. Stable candidate IDs break ties. Comparisons are strict: equality is not a breach. Monitoring uses sampled mean slots divided by the configured cap; zero caps and unknown values cannot trigger that rule. Acceptor latency and yield are evaluated per kind. An empty kind cannot trigger a kind rule. No model interprets the numbers or starts work.

If nothing qualifies, the card says `no clear constraint` and includes the top two candidates, their values, thresholds and evidence. The exploit/subordinate/elevate responses are advisory text templates for each constraint type; they create no actions. Queue share/growth have new `F:constraint.queue.<stage>.share.7d` and `.growth.7d` facts alongside their supporting stage-hour and cumulative-flow facts.

Project overrides are optional and validated in `src/config.ts`:

```yaml
producer:
  constraints:
    cause_shares:
      environment: 0.30
      # Other cause classes can opt in with their own ratio threshold.
    monitoring_cap_share: 0.40
    acceptor_p90_hours: 8
    first_pass_yield_min: 0.60
```

Ratios must be finite numbers from 0 to 1; hours must be finite and nonnegative. Unknown keys and cause classes are refused. Defaults apply to omitted keys. By default only environment has a cause threshold; unclassified outcomes remain explicitly unknown.

Risk definitions and retention:

- Failure signatures normalize case, whitespace, paths, UUIDs, timestamps, explicit run/order/process identifiers and numeric counters. They must recur across at least two distinct orders/runs; several reports from one run do not manufacture recurrence. Counts are distinct report/missing-report events across the available history, not refresh counts. Fact IDs identify each supporting normalized occurrence.
- Worker loops come from explicit loop failure reports or recorded `failed-loop` usage signals. Each worker/run counts once, even if both sources report it. Multiple detections preserve the earliest and latest observed times.
- Budget risks compare recorded consumption with the project's `budget.tokens_per_day`, `tokens_per_order` and `cost_per_day`. Days are UTC and costs use only the configured currency (USD by default). Stored turns replace run totals; missing turns fall back to a stored run total dated at run end, or run start for an open run with no observation timestamp. Counts are distinct over-budget consumption records, never poll counts. Known consumption is a lower bound when usage is missing; missing values are not inferred. New positive consumption must exceed the cap to recur.
- An open item older than its kind's positive seven-day p85 has one aging incident. A continuous incident keeps its first-seen time and count; resolution followed by recurrence increments the incident count. A missing/zero p85 or empty kind supplies no aging baseline. Aging evidence records the observed age and p85, so it remains meaningful after resolution.
- Every entry includes first/last-seen times, a count and evidence fact IDs. An unresolved aging incident recurs while observed; other entries recur only on recorded events. Entries and their supporting evidence persist until there has been no recurrence for seven days, including exactly the seven-day boundary. Resolved entries retain their last evidence during that grace period.

The Analysis tab shows the constraint, expandable fact values and standard responses, followed by a compact risk register, Flow/Routing sections, rule agreement and mode suggestions, and brief history. Its facts and insights endpoints load only when the tab opens. Links to past cases open Analysis and expand Order events and closed cases. These panels use the shared English/Chinese catalog. The conversation remains mounted when switching tabs, preserving its draft and reading position.

Historical replay orders supplemented event actions and backdated imports chronologically before inferring stage. This prevents an older synthetic queue action with a high sequence from overriding a later recorded approval. Event-only approvals also contribute completion facts; cancellation remains terminal without adding throughput. Direct approvals, table imports and acceptance-file sync all use the repository's `action-approve`/`action-cancel` event path.

The cause table also recognizes generic Chinese capacity, environment, tool, decision and verification failures, plus additional English verification and report-format errors. Explicit prerequisite causes retain priority over secondary incomplete delivery. Unmatched text remains unclassified; the rules contain no project identifiers or copied report summaries.

## Director conversation

The Producer page is a viewport-height workspace: conversation on the left, independently scrolling decisions/session/constraint rail on the right. Below 1100 px the rail stacks above chat. The director can ask questions, steer priorities, or request an order in any language. The producer prompt requires replies in the latest director message's language. Replies use the existing GFM Markdown renderer; raw HTML is escaped, project tag-pattern matches link to orders, and fact links expose stored values on hover. Each reply shows its time/status and Retry on error. Earlier narration belongs in collapsed Steps above the final answer.

The composer stays at the bottom of its pane. Enter sends, Shift+Enter adds a newline, the project draft survives reloads in local storage, and Stop cancels queued/running chat through `POST /api/producer/chat/stop` with `{project}`. Stopping an active turn stops its engine; a later chat can start a new one. New messages follow the bottom unless the reader has scrolled up. The four default localized quick prompts can be replaced per project:

```yaml
producer:
  quick_prompts: ["Full check", "Stalled runs", "What to dispatch next", "Brief"]
```

This accepts up to eight nonempty strings, each up to 1000 characters; an empty list hides the chips. Custom project text is shown as configured.

`POST /api/producer/chat` takes `{project, text}` and returns a stored message with HTTP 202 without waiting for the model. The serve coordinator processes messages serially per project: one recorded model turn per message, using the running session when idle, or a temporary engine with the same engine/model/tool configuration otherwise. The temporary engine stops after that turn. `GET /api/producer/workspace?project=...` supplies initial session/budget status, pending cards/questions, a compact constraint, referenced fact values and the last 30 messages. `GET /api/producer/chat?project=...&before=<nextCursor>` pages older messages chronologically with a stable message-id cursor, at most 30 per page. Scrolling up loads older pages without losing the reader's location. `/api/producer/chat/stream?project=...` streams only the latest page and current cards/status via SSE; reconnect merges by message id without dropping loaded history. `GET /api/producer/analysis?project=...` returns the stored fact snapshot separately. These reads do not recompute analytics or start model work. A running message interrupted by a serve restart becomes an error rather than being replayed.

The project state store retains `_producer-chat.json`, `_producer-direction.json` (every accepted version), `_producer-direction-proposals.json`, and the current `producer-direction.md`. The direction has priorities, work to stop, constraints, and notes dated when accepted. It lives outside the repository when the project's state folder is outside it. `producer_direction_propose` submits a complete edit against a base version. Accept/Reject calls `POST /api/producer/direction` with `{project, proposalId, accept}`. Stale edits are refused; repeated decisions are idempotent. The current direction accompanies startup and every later event/chat turn. Scheduled briefs use the same standing-direction reader.

`producer_read` additionally offers `facts`, `constraint`, `direction`, and `goals`. Facts and constraints go through the stored snapshot boundary (`producerSnapshot`), never an on-demand computation. Until those snapshots exist it returns `available: false`. The boundary reads the `producer-facts` metadata snapshot; constraints come from its `analysis.constraint`. Missing data returns unavailable until the coordinator refreshes it. Goals are optional `goals.md` in the state folder or `goals.md`/`goals.yaml` beside the project configuration. Answers must cite known `F:` ids for numeric claims or state that the number is unavailable. Chat captures the available fact ids at turn start and flags unknown ids and uncited numeric sentences in the thread; it never supplies missing values itself.

Work proposals use `producer_act` and the existing policy store/executors. The prompt supplies a conversation case key; `target` selects an existing order. Chat `add-order` requires an `order` object with `tag`, `title`, `kind`, `needs`, and full Markdown `body` containing an Acceptance section. Accept creates a draft through `createOrder`; queueing is a separate card through `humanAction`. `reprioritize` uses the order update service to set an integer `priority` (higher first within existing dispatch rules) or replace `needs`. Existing caps, routing and eligibility continue to apply.

Each chat action carries its originating `messageId`: only an action filed under that message's own case (`chat/<messageId>`) while the message runs gets it. A proposal for any other case made during the chat (a card turn's, or one sent by another process) does not borrow the id. Auto rules execute immediately and show `done`; off rules are refused. Observe proposals remain `would-do` until a director explicitly accepts one in chat; only a would-do whose message id and case agree (or a pending draft) can be run from the console, and any other would-do is refused as observed only. Compact cards show action, order, rule/mode and two lines of expandable note. `POST /api/producer/actions` with `{project, actionId}` accepts; optional `note` edits the stored note before execution. Adding `reject: true` durably rejects, with optional `reason`. Direction rejection also accepts optional `reason`. Checkboxes support sequential bulk accept/reject using the same endpoints and checks.

Each targeted proposal captures order stage, latest run and action sequence. A later human action, stage change or newer run marks it `superseded` with a reason; the rail greys it out and removes decision controls. Reads derive this state without mutating storage. Execution rechecks it and persists/returns `superseded` without applying the action. Missing orders are likewise unavailable. Targeted proposals without a captured basis are superseded and cannot execute. Acceptance also rechecks enabled/pause state, current policy hash/mode and case revision. Decisions remain audit records/events with the chat message id.

Citation checking ignores list markers, headings, dates/times, order tags, hex hashes, code, and numbers already supplied by the director or order/case keys. Unknown fact ids and remaining uncited numeric claims appear behind one collapsed count, rather than one visible warning per sentence. No missing fact value is inferred.

Chat shares hourly turn and daily usage budgets with event turns. `producer.session.timeout_ms` defaults to 120000; `max_turns` also limits the engine's tool rounds. Startup/send failures, timeout, MCP initialization failure and model errors become visible thread errors. No test starts a real model.

## Standing direction in planned drafts

Planned-order context uses the same `standingDirection` reader as director chat. Accepted direction accompanies the plan intent, project drafting template, needed delivery reports and acceptance notes, and recent accepted examples. The session sees this context in a `ready-to-draft` card and can read it through `producer_read kind drafting` with the order tag. A draft remains a stored `draft-order` proposal until accepted, unless both an auto rule and `drafting.auto_kinds` allow automatic queueing. Editing the body persists it without changing the standing direction. See [planned work](../workflow/002-orders-and-stages.md#planned-work-before-the-queue) and [drafting configuration](021-producer.md#planned-order-drafting).
