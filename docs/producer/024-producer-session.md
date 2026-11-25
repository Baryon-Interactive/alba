# 024. Producer session

The producer session is the optional persistent model guest of the producer host. Its persistent process starts only when both `producer.enabled` and `producer.session.enabled` are true; the host and its stored cases remain usable without it. Director chat reuses an idle running engine, or starts one temporary engine with the same configuration for one message when no session is running. Temporary turns share the durable turn history and producer budgets. See [Director conversation](025-producer-direction.md#director-conversation).

```yaml
producer:
  enabled: true
  session:
    engine: claude
    model: claude-sonnet
    cli: claude                 # optional executable path
    # profile: producer        # optional Codex exec-only profile; app-server rejects it
    config: []                 # optional Codex key=value overrides; ignored by Claude and agy
    effort: medium             # optional reasoning effort (omit to use the CLI default)
    max_turns: 40
    page_chars: 12000          # collection page size, positive integer
    timeout_ms: 120000         # chat deadline
    work_timeout_minutes: 10   # limit of one detached draft, review or work session (default 10)
    max_work_sessions: 3       # detached draft, review and work sessions running at once (default 3)
    turn_timeout_minutes: 15   # a router turn running longer is failed and the session restarted (default 15)
    error_retry_minutes: 30    # minimum interval between retries after an engine/MCP failure
    rollover_tokens: 100000    # optional context rollover threshold
    wake_triggers: [delivery, failed, blocked, question, no-report, loop, ready-to-draft]
    notice_triggers: [gap-unowned, target-unmeasured, idle-capacity, commit-reminder]
    notice_max_minutes: 120
    enabled: false
  budgets:
    turns_per_hour: 20
    usage_per_day: 100000
    cache_read_weight: 0.1
    cost_per_day_usd: 5         # optional; requires prices for accurate coverage
    draft_runs_per_day: 4
    review_runs_per_day: 8
  reviews: true                # false: no delivery reviews and no delivery cards; a person reviews
  model_prices:                # USD per million tokens; configure actual provider prices
    claude-sonnet: { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 }
```

The Claude Code adapter runs one `claude -p --input-format stream-json --output-format stream-json --verbose` process. The host writes an MCP configuration in the state folder. The allowed tools are the Alba producer MCP tools and `Read`; shell, edit, write and web tools are denied. The MCP server is started with `alba producer mcp --project <alba.yaml>` and speaks JSON-RPC over stdio without another dependency.

`producer.session.engine` accepts `claude` (default), `codex` or `agy`; omitting it preserves the Claude adapter. Engine settings are validated when loading the project:

| Key | Meaning |
| --- | --- |
| `engine` | `claude`, `codex` or `agy` (the [Antigravity CLI](#antigravity-agy)). |
| `model` | Non-empty model id passed to the CLI. Omit to use its default; unknown model attribution is shown as `unknown`. |
| `cli` | Non-empty program path, default `claude`, `codex` or `agy`. On Windows, point at the native `.exe`; `.cmd`/`.bat` paths warn on load and direct spawn errors are reported without falling back. |
| `profile` | Optional non-empty Codex exec profile, passed as `-p` after `exec`. App-server rejects it because it has no profile option; select the provider/account through `config` instead. Claude and agy ignore it with a configuration warning. |
| `config` | List of `key=value` Codex overrides, each passed as its own `-c` argument without a shell. Claude and agy ignore these with a configuration warning. Credentials remain in the CLI's provider configuration/environment. |
| `effort` | Optional `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Codex maps `max` to `xhigh`; Claude maps `none`/`minimal` to `low` and `xhigh` to `max`; agy maps `none`/`minimal` to `low` and passes the rest as `--effort`. The configured model must support the chosen level. |

For example, use model `model-x` through the invented provider entry `provider_p` already configured in Codex:

```yaml
producer:
  enabled: true
  session:
    enabled: true
    engine: codex
    model: model-x
    cli: codex
    config: ['model_provider="provider_p"']
    effort: high
  work:                         # optional; absent means use the session engine settings
    model: model-x-worker       # may also override engine, cli, profile, config and effort
  model_prices:                 # invented example prices, USD per million tokens
    model-x: { input: 1, cache_read: 0.1, cache_write: 0, output: 4 }
    model-x-worker: { input: 1, cache_read: 0.1, cache_write: 0, output: 4 }
```

`producer.work` accepts only the six engine keys above. A work override inherits unspecified keys when it keeps the session engine; switching engines starts with that engine's defaults so it cannot inherit the other engine's CLI/model/provider. An explicit `config` list replaces the inherited list. Work shares the producer budgets; its time limit is `producer.session.work_timeout_minutes`. A `profile` may be used for detached Codex work, which always uses exec. The router accepts profiles only when its binary lacks app-server support; a successful app-server handshake with `profile` configured fails clearly before starting a thread. Where supported, check provider startup configuration with `codex -c 'model_provider="provider_p"' app-server --print-startup-config` before enabling the session.

Codex first starts `app-server` and performs its initialization handshake, then starts one thread with the fixed system prompt and one turn per batch. If the configured binary cannot initialize app-server, the adapter uses `exec --json` for its first turn and `exec resume <thread id> --json` thereafter. Session status records `engine` and `mode` (`app-server` or `exec-resume`). Provider, thread or required-MCP initialization errors after the handshake are reported directly rather than triggering another request. Detached Codex work runs one `exec --json` request with the same configuration builder. Both paths replace the MCP catalog with the producer server, require it to initialize, set sandbox `read-only` and approvals `never`, and disable shell, file edits, web search and subagents. Host-owned safety and MCP overrides follow user overrides. Work attaches only the read-only producer server. Lifecycle, rollover, recovery handoffs and budgets use the existing session manager; detached work keeps its existing PID/start-time checks and timeout handling.

Codex exec receives `-` as its prompt: detached work opens the saved UTF-8 prompt as stdin, and router exec/resume writes the batch to stdin and closes it. Fixed instructions are loaded from a host-written file. Large contexts therefore stay out of the Windows command line; both first and resumed exec turns skip the Git repository check. The prompt file remains available for inspection. The engine has no hard per-turn kill timer; shared chat, brief and detached-work deadlines still apply.

The adapter requires `debug models --bundled` and `model_catalog_json` support. It writes a restricted copy of the bundled catalog with shell tools disabled and `apply_patch_tool_type` removed, since current Codex selects its patch tool from model metadata. A model id missing from the bundled catalog gets a copy of the closest entry (the longest slug that prefixes it, e.g. a provider alias, else the longest shared leading run), not the first entry. The catalog is prepared once per Codex executable and model for the life of the host process, and the shared catalog and instruction files are replaced atomically so a starting Codex never reads a half-written file. It also disables unified exec and agents explicitly. MCP startup has a 60-second allowance. Its server receives explicit worker-path, read-only and English-language settings plus inherited `NODE_*` and `CODEX_HOME`, with inherited Alba settings and tokens excluded. Model-engine subprocesses and catalog probes use the worker environment boundary. To verify the installed binary's effective tools without a provider call, set `ALBA_CODEX_TEST_CLI` to its native executable and run `node --test test/producer-codex-tools.test.ts`; the test captures the request at a loopback HTTP server.

The protocol adapter follows the [official Codex app-server documentation](https://developers.openai.com/codex/app-server/); tests use local fake JSON-RPC and exec CLIs without provider calls.

### Antigravity (agy)

`engine: agy` runs the official Antigravity CLI directly (never through OpenCode or a gateway), signed in with its own Google account. For example:

```yaml
producer:
  session:
    enabled: true
    engine: agy
    model: gemini-4-carbon-high   # an id that `agy models` lists
    cli: agy                      # on Windows, the full path of agy.exe
```

agy has no command-line option for MCP servers or a tool list, and `agy mcp add` would change the person's global configuration for every agy run. The host therefore writes a custom agent into a workspace folder of its own, `<state_dir>/producer-agy/.agents/agents/alba-producer.md`, and starts `agy --input-format stream-json --output-format stream-json --agent alba-producer --settings <state_dir>/producer-agy/agy-settings.json --disable-slash-commands --add-dir <project root> -p=` in that folder. agy finds a workspace agent only in the folder it runs in, so nothing outside the state folder changes:

- The agent lists only the producer MCP server (`mcpServers`) and sets `inheritMcp: false`. agy still connects to the servers of the person's own `mcp_config.json` when it starts, but the agent cannot call them: agy answers `tool ... is not enabled for server ...` even when a permission rule would allow it.
- `tools: ["view_file"]` is the only built-in tool listed; agy adds its MCP call, resource read and task list tools. `inheritCustomizations: false` leaves out ambient rules, skills and subagents, and `commandExecutionPolicy: "off"`. The agent body is the fixed system prompt.
- The `--settings` file is used for this session only (agy never saves it). It sets the default agent mode with `request-review` permissions, allows `read_file(*)` and `mcp(alba-producer/<tool>)` for the producer tools, and denies `command(*)`, `write_file(*)`, `read_url(*)`, `execute_url(*)`, `download_url(*)` and `unsandboxed(*)`. Deny rules win over the person's own allow rules, and headless agy refuses every action that would ask for approval; `--dangerously-skip-permissions` is never passed. The producer MCP server enforces its own read-only and action gates as with the other engines.

Each stdin line `{"event":"user","message":{"role":"user","content":...}}` is one turn with its own `result` event. Usage is charged per finished `agent_response` step (agy's `input_tokens` exclude the cache read, its `output_tokens` include thinking); the cumulative usage of a `result` is not charged again. Turns, usage and the usage history record engine `agy` and the configured model, and producer MCP calls appear under the same tool names as with Claude. If agy ends cleanly before it started on a turn, the turn goes to a new process that resumes the conversation with `--conversation <id>` (once per turn); any other exit is a lost session and follows the usual restart and recovery. Detached work with `engine: agy` runs `agy -p "<read the prompt file>" --output-format stream-json --agent alba-producer-work ...` in its own work folder with the read-only producer server and only `producer_read` and `producer_notes` allowed.

Limits: agy writes the producer tool schemas to its own cache (`~/.gemini/antigravity-cli/mcp/alba-producer/`), connects to the person's global MCP servers at startup as described above, and reports no MCP startup failure in its stream, so a producer server that cannot start shows up as a turn whose tool calls fail rather than as a session error.

After building the UI, run `node --disable-warning=ExperimentalWarning test/producer-usage-browser.mjs artifacts/producer-usage` for a mock Activity check and English/Chinese 1440×900 screenshots with two models and separate cache hit rates. Set `ALBA_BROWSER` to a Chromium executable when needed.

The persistent guest is a thin router. Cards contain bounded fields: case key (240 characters), trigger (64), order (80), stage (64), one-line summary (240), up to four ids (100 each), allowed operations, and an optional compact work result. Complete goal records, drafting bodies and delivery evidence stay behind reads or in detached workers. The prompt forbids waiting, polling and sleeping: finish the turn and receive results as messages.

Policy format version 2 has a fixed system prompt and ordered tool catalog. Notes, direction, timestamps, counts and changing facts never enter that prefix. Policy rule text/modes or a host policy/tool schema release may change it; restart to apply a new policy. The MCP configuration is byte-stable for the same executable, CLI entry point, project file and read-only mode. The tool server uses English schemas regardless of the UI language. Model/provider changes and CLI upgrades may affect caching outside the host's control; prefix stability alone does not guarantee a provider cache hit.

Every tool advertises its arguments and field descriptions in `tools/list`. The action enum comes from the same `PRODUCER_ACTIONS` constant used by the policy gate, and calls are validated against the advertised schemas before execution.

Call `producer_read` with `{"kind":"status"}` first. Its `{text}` response stays below 6,000 characters and summarizes open orders by stage, stalled runs using the board/tick rule, kind and resource caps (used/limit), memory versus the project minimum, dispatch blockers, open case keys by trigger, holds older than three days, and each producer rule's current mode. Order lines carry tag, kind, worker, last commit timestamp and minutes since it, run age in minutes, and latests status. Commit times come from git in the order's worktree; `?` means unavailable. Log activity and long-command exceptions follow the tick, so old commits alone do not imply a stall. A stage summary and explicit omission counts preserve the size bound on large projects; use filtered reads for omitted details. Status always excludes merged/cancelled orders. It does not start a run or refresh facts.

`producer_read` requires `kind`: `status`, `cases`, `actions`, `notes`, `orders`, `order`, `runs`, `reports`, `verify`, `log-tails`, `decisions`, `diff-stats`, `shared-rules`, `facts`, `constraint`, `direction`, `goals`, or `drafting`. Collections return `{page, pages, text}` with a zero-based, non-negative integer `page` (default 0), the total number of pages (`pages`, at least one), and up to 12,000 characters of text per page. Configure a positive integer `producer.session.page_chars` to change the size. JSON collection text can span pages: concatenate the `text` fields before parsing. An out-of-range page has empty text and still includes the total count. Kind `drafting` requires `tag` and returns the complete planned-order drafting context; see [planned-order drafting](021-producer.md#planned-order-drafting).

Collections are newest first. Optional filters:

- `stage`: the current order stage, including for associated runs, reports, cases and actions.
- `tag`: one order tag or a nonempty list, matched without regard to case. `kind=order` requires a single tag.
- `since`: an ISO timestamp with a timezone, inclusive. Orders/diff stats use the order update time; runs/log tails use run start; reports/actions use their own timestamp; cases/verification use case update; facts use the snapshot timestamp.
- `trigger`: a case trigger, also applicable to verification cases.
- `include_closed`: default false. True includes merged/cancelled orders and their records, closed cases and cases superseded by a newer run. Status always excludes these.

For example, `{"kind":"runs","stage":"running","tag":["DEMO","BUILD"],"since":"2026-01-01T00:00:00Z"}` reads recent starts for selected running orders. `{"kind":"cases","trigger":"question"}` reads current questions. These reads filter stored data without closing or rewriting cases.

`kind=facts` returns `{available, page, pages, text}`: one line per stored fact with its id, value and unit, without tags, evidence lists, timelines or analysis. It reads the current tick snapshot only. Tag/stage filters select facts whose tags intersect the matching orders; untagged aggregates are omitted under these filters. `{"kind":"facts","fact":"F:kind.code.wip.24h"}` returns `{available, value}` for that one complete fact, including tags/evidence when present (`value: null` for an unknown id). Held orders are excluded from per-kind WIP and cap occupancy; new snapshots expose a separate per-kind `held` fact. The read path does not reinterpret stored metrics.

`constraint`, `direction` and `goals` reads return `{available, value}`; missing snapshots/goals are explicitly unavailable. `producer_direction_propose` submits a complete standing-direction edit for a director click. Read current direction as needed; it is data rather than part of the system prefix. A reproducible status example and its character count are in the [compact read fixture tests](../producer-compact-reads.md).

Before judging a delivery, read its order:

```json
{"kind":"order","tag":"DEMO"}
```

Kind `order` requires a non-empty `tag` and returns one JSON object: `tag`, `title`, `stage`, `kind`, `needs`, `body`, `report`, `verify`, and `actions`. It ignores `page` so delivery facts cannot be split or cut off by collection paging. The UTF-8 body is capped at 12 KiB; Acceptance, Evidence and Paths sections, including subsections, are reserved before other text is shortened. If these sections alone exceed the cap, they share the available bytes and retain their headings and opening text. Truncation is marked explicitly and never splits a UTF-8 character. The latests has status, summary, evidence paths and commits (`null` before a report exists); verification results have name, status and reason from the latest stored `order-verified` event (an empty array before verification). The last five human actions are returned newest first with kind, note and timestamp. This read does not run verification or change order state.

`producer_act` accepts one to twenty proposals and sends each through the existing policy gate:

```json
{"actions":[{"case":"delivery/DEMO/r1","kind":"note","note":"Review the delivery","reason":"The report and verification are available","evidence":["proof.txt"]}]}
```

Each item requires non-empty strings `case` (a case id or key from `producer_read`) and `kind`. Kinds are `nudge`, `answer`, `queue`, `hold`, `rework`, `accept`, `accept-part`, `add-order`, `broadcast`, `ask`, `note`, `close-case`, `reprioritize`, `dispatch`, and `clean`. Optional `note` and `reason` are strings; optional `evidence` contains at most twenty string paths. `add-order` requires a full `order` object (`tag`, `title`, `kind`, `needs`, `body` with Acceptance) for every case. `target` selects an existing order. `reprioritize` sets `priority` or `needs` using the order update service. Replacement `needs` keep every need that is not merged yet and make no cycle, checked when proposed and again when run: the producer may reorder and add dependencies, never let an order start ahead of what it depends on (only a person removes an open dependency). Calls use the `actions` array; direct fields and `caseId` aliases are rejected. Invalid kinds, missing required fields, invalid types and unknown fields reject the entire batch before any proposal or audit entry is recorded; the error lists valid kinds and required fields.

Planned-order cases also accept `draft-order`, with a full `order` object preserving the plan's tag, title, kind and needs, plus the body and optional worker hint. Accepting the draft keeps the order's worker and any producer pin (`next_worker`); the hint only fills an order that has neither. A detached draft worker receives the complete context; the router receives its id and summary. Acceptance and automatic-kind limits are described in [planned-order drafting](021-producer.md#planned-order-drafting).

The session prompt requires an order read before judging a delivery and treats a person's approve, rework or cancel as final: the producer must not re-propose against it.

`producer_notes` reads notes with empty arguments. Providing `text` writes them; `replace: true` replaces instead of appending. The `write`, `action` and `note` aliases are rejected. Omit `tag` for project notes or supply an order tag for per-order notes. `producer.session.notes_chars` sets the character limit (default 8,000). Project overflow and replaced project notes roll into `producer-notes-archive-YYYY-MM-DD.md` in state. Order notes remain separate. Both reject invisible characters and text addressed to the model as an instruction. Both appear on the Producer Analysis tab and the order page; `producer_read kind=order` includes both scopes.

`producer_draft {case,brief?}`, `producer_review {case,brief?}` and `producer_work {case,brief?}` start detached one-shot work and return immediately with an id/status. The host automatically starts draft work for eligible planned/goal drafts and review work for deliveries. Other work takes a brief of at most 2,000 characters. Running and successful work is reused by case fingerprint. Failed work can start a new id immediately, then at most one retry per case in a rolling hour, including across host restarts. A ready-to-draft case whose last draft failed is sent to the router again and retried by the host on a later pass, up to two draft sessions under the current `work_timeout_minutes` (sessions under an older, shorter limit do not count); after that a person uses **Draft again** on the order page (`POST /api/orders/:tag/draft-again`), which is not bound by the hourly rule. A rejected draft is not retried. Each retry consumes its own allowance. Drafts consume `draft_runs_per_day`; reviews and generic work share `review_runs_per_day` with independent acceptance checks. Work also consumes the shared daily usage/cost budget. At most `producer.session.max_work_sessions` (default 3) run at once; another start is refused until one ends. Exhausted allowances and a full set of running sessions leave cases eligible for a later pass. Serve reconciles running work every thirty seconds whether or not the router session is enabled, so a person's **Draft again**, or work left running when the session was turned off, still finishes, is metered and is stopped at its time limit.

Each work session has its own state-directory folder, prompt and JSONL log. Its fixed task (draft, review or work, with the result format) is the system prompt, the same text for every session of that kind, so a provider can reuse its cache across sessions; the prompt file holds only the case: the router's brief, the context and, on a retry, `previous_attempt` with the reason the last try failed, the router's brief and newest note on the case, and advice (read less after a timeout; keep the body out of the JSON after a JSON error). A session may run `producer.session.work_timeout_minutes` (default 10); `timeout_ms` is the chat deadline only. Claude work runs in the project root (the same folder as the router, so relative paths in the context resolve) with `--include-partial-messages`, so its usage is metered from the final message events (below). Claude work allows the built-in `Read` tool; Codex work reads through MCP. The MCP server accepts only producer reads and note reads. It cannot mutate producer state, launch workers, propose direction or contact people. The host reconciles detached processes by PID plus recorded start time, refuses missing/changed identities, and stops only the matching process on timeout or completion. A lost process or malformed result fails the work without an action. The router sees that failure as a compact card.

Only an explicit final block in the engine's result text becomes a result; bare JSON and tool output cannot grant an action. The parser selects only the last marked block, tolerating enclosing Markdown fences, a fence inside the markers, and trailing text. A malformed last block reports its own JSON error instead of falling back to an earlier example. A present but invalid block records its exact validation error, including an invalid action's field path, in the work record and Activity child row:

```text
--- alba-producer-work ---
{"summary":"Draft ready","action":{"kind":"draft-order","order":{"tag":"SAMPLE","title":"Example","kind":"docs","needs":[]}}}
--- end ---
--- alba-producer-body ---
# SAMPLE Example

## Acceptance
A reader can repeat the example.
--- end body ---
```

A draft puts the order body, as plain Markdown, between `--- alba-producer-body ---` and `--- end body ---` after the final block: a long body with quotes, backslashes and paths broke the JSON string it used to travel in. A `body` inside the JSON is still read when there is no body block.

A review only comments: it returns a `finding` and at most a `note` action; an accept or rework result is refused. Sending work back is the router's proposal and a person's decision (see the end of this page), and `producer.reviews: false` turns reviews off: no review sessions start and delivery cases are not sent to the router. The router decides with `producer_act {case,kind,work:id}`; the host retrieves the full payload, verifies the case fingerprint and runs the normal policy/acceptance gates. Nothing is executed by parsing the worker result. The router proposes only a result it was shown: a finished work's card carries its summary, finding and proposed action (long texts cut to 600 characters, the finding to 1,200), and sending that card records `shownAt` on the work; `producer_read {kind:"work", id}` returns the whole result and records it too (a read-only work session reading it does not). A result not yet shown is refused with what to do.

Accepting or sending back an order waiting for review (`accept`, `accept-part`, `rework` whose target is `awaiting-review`) needs the finished review of its current delivery, whichever case the proposal is filed under: `producer_act {case,kind,target,work:<review id>}`. The review must be done, belong to the order's open delivery case at its current fingerprint, and have been shown to the router; its log is added to the evidence. With `producer.reviews: false` such a proposal is refused: a person reviews the delivery on its order page. Activity shows a child row under the case with worker, duration, tokens, result and evidence paths.

Goal cards (`target-failing`, `target-unmeasured`, `gap-unowned`, `idle-capacity`) are sent only while the `draft-from-goal` rule proposes or acts; in `observe` or `off` nothing can come of them, so they do not cost a turn. In a `cases` read a goal case carries the ids of its system's rules and gaps, not their texts; `producer_read kind=design` reads those.

Default wake triggers are `delivery`, `failed`, `blocked`, `question`, `no-report`, `loop`, `ready-to-draft`, `stalled-run`, `monitor-stale`, `dispatch`, `repeated-failure`, `clean`, and `target-failing`. Default notices are `gap-unowned`, `target-unmeasured`, `idle-capacity`, and `commit-reminder`. Notices are stored, ride with the next wake, and flush together after `notice_max_minutes` (120 by default). `wake_triggers` replaces wakes; old `send_triggers` is its alias when `wake_triggers` is absent. Explicit wakes take precedence over default notices. Set both lists empty to disable card sends. Other triggers remain visible on the page without starting a turn.

Cards arriving during a turn are stored and collapsed by case to the latest revision, then sent in one next message. A turn that has not ended after `producer.session.turn_timeout_minutes` (default 15) would hold every later card and chat message back: the next producer pass fails it (its cards become unsent again), stops the engine, records `session-turn-timeout` in Activity, and starts the session again with a recovery note before the waiting cards. Questions, blocked, failed and delivery cases lead, followed by other cases oldest first. Queued notices survive restart; closed cases are removed. Serve checks deadlines and worker results every thirty seconds even without scheduled rounds.

A card is sent again only when its run, report, report status, order stage, scheduled-round attention fingerprint, drafting fingerprint, or acceptance-trial fingerprint/status changes. Revisions caused by summaries, related-order lists, or counters do not warrant another turn. These compact fact keys are durable, and are marked sent only after a successful send; a budget refusal leaves the card eligible. The host waits for an outstanding card turn to finish before sending more cards.

Session state, seen fact keys, budgets, notes, heartbeats and recovery data are durable in the project state folder. Rollover compares `rollover_tokens` with the last request's prompt size (uncached input + cache read + cache write), never accumulated session usage. `max_turns` and UTC day change still roll the session. A rollover records a handoff request bounded to 2,000 characters and starts a fresh process with the answer; a dead process is restarted with a recorded recovery note and backoff. The session never waits for a long job: tool calls return immediately.

For Claude with `--include-partial-messages` (the router and work sessions), a request is charged from its final `message_delta` event; the usage at `message_start`, which every `assistant` event repeats, is provisional: it has no output tokens, and a gateway may put an estimate there that differs from what it bills (seen on the local gateway: two to three times the input it bills, with cache read equal to cache write). A message without stream events is charged from its `assistant` events, deduplicating repeated message ids; cumulative result envelopes are not charged again. Turn records retain request ids and usage categories. `_producer-session-budget.json` preserves old fields; old `dayUsage` remains spent. `_producer-usage-days.json` stores per-project UTC daily totals. `usage_per_day` means **uncached input + cache write + output + cache read × cache_read_weight**, with weight 0.1 by default. Optional model prices use USD per million tokens, and `cost_per_day_usd` limits recorded priced usage. Missing prices are shown explicitly as unpriced tokens and cannot contribute to the USD cap, so with `cost_per_day_usd` set a model without a `model_prices` entry (or the engine's default model, which has no name to price) is refused before anything is spent: the router sends no turn and stores the reason in `lastError`, and no work session starts.

For Claude, `input_tokens` on each assistant request excludes cache categories: uncached input, cache read and cache creation are added for total prompt size. Codex reports cached input inside total input: uncached input is `input_tokens - cached_input_tokens`, cache read is `cached_input_tokens`, and cache write is zero. Codex output already includes reasoning; `reasoning_output_tokens` is not added a second time. App-server token updates and exec `turn.completed` usage are cumulative within one thread: the host subtracts the previous total using a stable thread key, ignores repeats, and treats decreased totals as fresh usage. Only an explicit last-request input count determines Codex context rollover. Exec totals without that count leave context size unset, so accumulated usage cannot trigger an early rollover. Every recorded request retains engine and model attribution.

Activity lists the last seven UTC days by engine/model: requests, uncached input, cache read, cache write, output, cache hit rate (`cache read / (uncached input + cache read + cache write)`) and cost or unpriced coverage. Current session status and the conversation rail show the same categories for that session. `alba producer usage [--days N] [--json]` reads the same stored daily rows (default seven days, positive integer). Prices accept arbitrary model ids. Existing daily totals remain spent; days without model/request attribution are not reconstructed into model rows. A cache hit is reuse reported by the provider; a stable prefix alone does not guarantee it.

At 80% of either daily limit, one Activity warning and a status problem are recorded; at 100%, further router sends and work starts pause until the next UTC day. Already running requests can finish beyond the cap. Activity shows today's four token categories, billed-equivalent total, priced USD, unpriced coverage and cache hit rate (`cache read / all prompt tokens`). Totals without category attribution have no reconstructed category history. Proposed actions are persisted as `superseded` on the next pass when stage, run or action sequence changes; closed goal and cleanup cases expire too, so Needs you contains current decisions. See the [scripted-day measurement](../../test/producer-router.test.ts).

Every turn is stored in `_producer-session-turns.json` through the configured state store (files or SQLite): its number and timestamp, sent card keys/triggers/revisions or message/handoff/recovery note, answer text, tool calls with correlated results or errors (inputs/results shortened to 300 characters), and input/output/total token usage. The newest 200 turns are retained, including in-progress turns and errors. Turn numbers continue across rollovers. `GET /api/producer` exposes the newest 50 in chronological order as `session.turns`; `session.turnCount` supplies the current session's aggregate count. CLI session status retains its numeric `turns` field.

The Producer workspace keeps director chat and its composer in one scrolling pane, with decisions and session status in a separate rail. The rail shows active/idle state (independent of whether the persistent engine process is alive), model, last turn time, today's turns and tokens against the daily budget, rule modes, and pause/resume. Below 1100 px it stacks above chat. The Analysis tab loads stored constraint/risk/flow/routing panels separately; its folded Order events section loads the older session history only when expanded.

Tool narration is stored separately as `narration`: each new tool call moves preceding text into this list and clears the answer. Only text after the last call remains the answer. Both chat and historical turns render GFM Markdown and put narration plus correlated tool arguments/results in a collapsed Steps block. During a live turn, the latest tool name and arguments form one truncated status line. `lastTurnAt` records sends and `active` indicates an outstanding turn; heartbeats retain their existing meaning.


The durable session states are `disabled`, `stopped`, `starting`, `running`, `paused` (budget), and `error`. Serve reconciles them at startup, on each tick, and on its thirty-second producer pass. Disabled sessions become `stopped`. If a recorded running, starting or budget-paused owner is gone, or its OS process start time proves the PID was reused, the session becomes `stopped` with a `recovery` record: detection time, lost owner identity and the recovery handoff. When process identity cannot be established, a live owner remains protected. An unavailable process-time probe does not prove that a live owner was lost.

Serve creates a manager for every enabled session, including recovery and error states. A wanted session is started again when serve starts; see [Wanted across a serve restart](#wanted-across-a-serve-restart). Any other host recovery starts no engine until a fresh wake card or overdue notice is due (director chat can also start it). A session a person stopped is not started for those cards. The new engine receives the existing “stopped unexpectedly” recovery handoff before any cards; interrupted cards remain queued until that turn finishes. Activity shows “Recovering after host restart” during this idle wait, and tick does not report a stale session heartbeat for that known cause. A successful recovery clears the note. Pending cards and sent fact keys remain durable, so recovery does not replay unchanged completed cards.

The stream-json `system/init` event is checked for failed entries in `mcp_servers`. A failed connection stops the engine, stores the server name/error in `lastError`, and marks pending turns with the error. Engine start failures and repeated process crashes also enter `error`. Failures persist `errorAt` and `retryAt`; `producer.session.error_retry_minutes` sets the retry interval (default 30 minutes, positive whole minutes). An eligible wake may retry once the deadline passes. Each failed attempt sets a new deadline, including after a serve restart, and the previous error stays visible throughout startup until a start succeeds. Errors without a deadline receive one on reconciliation. Activity and tick show “will retry at HH:MM” with the error rather than a stale-heartbeat warning. With no wake due, the session stays idle after the deadline. Explicit `session start` and a new director chat message can retry immediately after a configuration fix.

Unexpected engine exits first use the existing 1, 5, 15 and 30 minute restart backoff with a recovery handoff; another crash enters `error` with the configured retry interval. A completed turn resets the crash sequence. An explicit stop cancels pending restarts and clears recovery/retry data. Stopping a detached owner requires its recorded process start time to match; state without that identity is only marked stopped, without signalling the PID.

`alba producer session start` sends an authenticated local API request to `POST /api/producer/session/start` when a live serve holds the state lock. Serve forwards it to the same coordinator manager used for wake cards; concurrent starts share one engine. The lock publishes the actual HTTP port after listening, and session ownership records the serve PID and OS start time. An unreachable or still-starting serve produces a command error rather than a detached fallback. Without serve, start retains its detached worker behavior. `session stop` also routes through serve when present, so it stops the engine without terminating the host.

The session status is visible from `alba producer session status|start|stop` and in the `session` object returned by `GET /api/producer`. Budget usage warns at 80% and pauses at 100%. Pausing the producer stops router spend as well as new actions: while paused no card, chat, brief, handoff or recovery turn is sent, a wanted session is not started, and cards stay queued until a person resumes. Session proposals are recorded in the existing would-do log while rules remain in `observe`.

## Wanted across a serve restart

`producer session start` stores `wanted: true` on the session record. `producer session stop` stores `wanted: false`. Shutting serve down, or losing the host, does not change that mark. A record from before this flag exists is not wanted, so it is not started on its own.

When serve starts, a wanted session that is not running, or whose heartbeat is older than ten minutes, is started once. The start uses the same checks as the command: the session must be enabled, and a live owner is left alone so a second engine is never started. The thirty-second producer pass repeats the check when the heartbeat is stale. A failed start waits 1, 5, 15, then 30 minutes before the next attempt. Each attempt appends an event `producer.session-restarted` with `reason` `not-running` or `stale-heartbeat`.

`alba producer session status` includes `wanted` and `lastRestartedAt`. The board's producer Now line, the producer rail, and the Analysis session panel show whether the session is wanted and when it was last restarted automatically.

Scheduled briefs optionally reuse an already running, idle session for a `brief` turn. They never start a model just to produce a status report. The deterministic skeleton exists before that turn, which shares the hourly/daily budgets and durable turn history with chat and event turns. Chat and event-card turns are serialized against the rewrite. The brief stores the current standing direction alongside its evidence. Instructions require short prose in `producer.brief.language`, with every numeric token and citation preserved, and no tool calls or actions. A timeout stops the guest; an unavailable, refused or invalid rewrite keeps the skeleton. Tests inject a fake engine and assert that prose numbers are a subset of the skeleton's, with no new or missing citations.

The Producer page's Analysis tab shows rule agreement and mode suggestions without unfolding Order events, plus newest-first brief history and its evidence. Accepted proposal edits can use `POST /api/producer/actions` with `{project, actionId, edit: {note}}`; a successful edit counts as `edited`, while an unchanged acceptance counts as `accepted`. Rejections and successful acceptances update the stored trust record immediately. Automatic execution is marked as producer activity and does not manufacture human agreement. See [trust and schedule configuration](021-producer.md#trust-is-measured) and [English/Chinese fixture briefs](../../test/producer-briefs.test.ts).

The optional [scheduled round](021-producer.md#scheduled-round-and-actions) runs its status read and checks without an engine, even with automatic ticking disabled. Serve creates the session manager at startup, but starts the engine only for eligible fresh cards or director chat. An empty round stores its brief and sends no model turn. Round cards carry stable evidence fingerprints so an unchanged warning does not spend another turn.

## Rework, planned orders and the producer settings

A producer `rework` is always a proposal, whatever the mode of its rule: a person accepts it. It is refused when the order is `running` or `held`, both when it is proposed and when a person clicks it. `dispatch`, `queue` and `accept` of a `planned` order are refused with what to do instead: the order needs a draft first (`producer_draft` on its `draft/<TAG>` case once its needs are merged), and the router offers that draft to the director.

The console's Producer page has a **Settings** button: it shows the `producer:` section of the project file as YAML. **Preview** checks the whole file the way serve reads it and shows the changed lines; **Save** writes it with a `.bak-<time>` copy next to the file. Only the lines under `producer:` change; the rest of the file stays byte for byte, line endings included. Serve reads the file again by itself. The API is `GET /api/producer/config?project=` and `POST /api/producer/config {project, yaml, dryRun?}`; an invalid value is a 400 and nothing is written.
