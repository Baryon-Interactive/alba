# 020. Usage and cost

`alba usage [--project alba.yaml] [--since 24h|7d|30d|YYYY-MM-DD] [--by day|worker|project|order|kind] [--top N] [--json]` reads the run ledger. Repeat `--project` to combine projects. The default period is seven rolling days. Dates and day groups use UTC. Each total equals the sum of the displayed rows; a limited JSON result also includes an `omitted` total. Unknown observations are counted separately, never treated as a measured zero. The older `--days N` option continues to select external tool ledgers (`usage_ledgers`), also available through the Spend page and `/api/usage`.

## Sources and storage

The  incremental event reader feeds accounting as complete lines arrive. The ledger stores project, order, run, worker, engine, model, time, turn, kind, rework/resume flags and source, alongside all supplied token counters. Raw usage objects retain fields a future engine may add. Input/cache/output/reasoning counters are optional: a missing counter remains unknown. Cached input is part of Codex input; OpenCode, Grok and Claude report cache separately. Reasoning is part of Codex/Claude output and separately reported by OpenCode. Aggregated input includes cached input, and aggregated output includes reasoning, without counting either twice in the overall token total.

| Engine | Source | Available counters |
|---|---|---|
| Codex CLI | `codex-json`, `turn.completed.usage` | Input, cached input, output, reasoning and cache writes when supplied; raw usage fields retained |
| Codex legacy | `codex-log` | Last `tokens used` text-log total; no invented split |
| Codex rollout | `codex-rollout` | Named session's `event_msg/token_count` cumulative totals under `CODEX_HOME/sessions`, or the default Codex home; subtract the baseline before the run for resumed sessions |
| OpenCode | `opencode-json`, `step_finish.part.tokens` | Input, output, reasoning, cache reads/writes, total and reported cost when present |
| Grok CLI | `grok-end`, streaming JSON `end` | Reported total, input, output, reasoning, cache reads/writes and cost when present |
| Claude session | `claude-json`, supplied assistant/result stream | Assistant usage per message, deduplicated by message id; result totals only when no assistant usage was collected |
| Any engine without usage output | `unknown` | No measured zero; a card-only Claude session normally has no captured stream |

This builds on the documented  CLI formats and recorded engine fixtures. It does not start paid engine sessions or run account-wide `opencode stats`: those totals cannot safely be attributed to an order. A supplied Claude event file is required to observe a manually started session. Model and engine are captured on newly launched runs; older unidentifiable values remain `unknown`.

When a run has no event file, accounting prefers the named Codex rollout if a timestamped run interval can be recovered, then the text log. Only rollout token-count totals are read; conversation content is not imported. Counter resets that prevent safe subtraction fall back to the log. A partial final JSON line waits for its newline. Completed ledger rows survive log removal. Active files rebuild through the same event reader after a restart.

SQLite schema **4** adds `usage`, keyed by **order/run and turn**, with time, worker and order indexes. File state uses `_usage.json`; collection batches updates into one atomic rewrite. Migration, backup and export retain the ledger through the existing portable metadata slot. There is no additional dependency. Ticks, usage requests and order detail requests collect observations; the cross-project Overview reads only persisted rows and cached findings, without scanning event history or running probes.

## Prices and subscription windows

An optional top-level `pricing` mapping uses worker ids or model names as keys; a worker's own `pricing` overrides the mapping. Worker keys take precedence over model keys. All rates are **example values** per million tokens:

```yaml
pricing:
  example-model:
    input_per_mtok: 2
    cached_input_per_mtok: 0.5
    output_per_mtok: 8
    currency: USD
workers:
  - id: example-paid-worker
    engine: codex-cli
    cost: paid
    launch:
      program: example-cli
      model: example-model
      args: []
```

For paid workers, the ledger calculates `(uncached input × input rate + cache reads × cached rate + output × output rate) / 1,000,000`. Every calculated amount is labelled **estimate**. Currencies remain separate. No price means tokens only. Cache-write usage is retained, but a run with cache writes has no estimate because this table does not specify a write price. An engine's reported USD cost remains on its usage record, separate from table estimates. Legacy worker `price` and existing hard spend caps retain their previous behavior.

Included workers show tokens and the observed percentage-point change in each quota window between the last reading at/before start and the last reading during the run. Resets and decreasing counters are excluded. Missing anchors mean an unknown share. A shared quota is labelled as a **shared window change**: concurrent workers and use outside alba can contribute, so this is an observed source delta, not exact per-run attribution. No money is estimated for included workers.

## Console and warnings

Every project has a Usage page (`/p/<project>/usage`, `/api/usage/runs?project=&since=`): daily stacks, worker cache/reasoning shares, top orders, estimates per merged order by kind, and warning evidence. The Overview tile shows today and seven days by worker/project, cached share, median and p90 tokens per merged order, and five open runs ranked by available estimate, then tokens. Merged-order metrics use lifetime observations for orders merged within the selected period; token quantiles exclude orders with unknown usage, and a kind with incomplete pricing shows an unknown cost average. Missing split counters also make the corresponding share unknown. Runs without a comparable price are ranked by tokens. The order page includes each run, sources, estimates or subscription changes, totals, and rework/resume shares; those shares can overlap.

All six waste signals appear on the order page with run, turn range and command/file evidence. To put them in the attention strip, configure thresholds in the project file. Omitted fields in an enabled block use these defaults:

```yaml
usage_warnings:
  tokens_without_commit: 1000000
  long_run_tokens: 1000000
  min_cached_share: 0.2
  command_output_bytes: 100000
  repeated_file_reads: 5
  failed_repeats: 3
  reasoning_share: 0.8
  reasoning_by_kind: { research: 0.95 }
budget:
  tokens_per_day: 10000000
  tokens_per_order: 5000000
  cost_per_day: 20
  currency: USD
```

Failed-command signals reuse the loop detector on consecutive commands with the same normalized error; a success breaks the streak. File-read signals recognize file-reading commands in captured command/tool events. No-commit accounting resets at a successful `git commit`; the commit's containing turn is excluded because token usage cannot be split within a turn. Reasoning/cache signals require the respective measured counters. Thresholds are evidence for an operator to review, not a verdict that work was unnecessary.

Budgets only warn. Daily token and order token limits use known token observations; cost uses available estimates in the explicitly configured currency (USD by default). Unknown prices cannot establish a cost crossing. Real ticks add warnings to the attention strip and persist one thread event per warning category, order and UTC day. Project daily warnings also appear on affected order pages. A warning never stops or prevents a run; the older explicit spend-cap mechanism is unchanged.

To reduce waste, point work orders at specific files instead of pasting their contents, cap command/log output, run long commands in the background and poll their status, and split huge orders into reviewable steps. Repeated file reads often suggest a missing concise reference; low cache reuse can suggest changing prefixes or oversized context; unusually high reasoning should be judged against the order's kind before changing its model or effort.

## Verification

`test/usage-accounting.test.ts` covers recorded Codex turns, raw counter retention, engine formats, text/rollout backfill and resumed baselines, pricing, unknown usage, every grouping/top limit, all six signals, quota attribution, API totals, advisory budget events, order/run key isolation and migration/export. `node --disable-warning=ExperimentalWarning test/bench-usage.ts` times the actual CLI process for each grouping on 20,000 rows with both stores and writes ignored `.alba/evidence/usage-bench/timing.json`; each sample must be below one second. Synthetic console screenshots and check logs are kept in ignored `.alba/evidence/`.

## Results by role and worker

The Usage page and `/api/usage/runs` include accepted-without-rework share, median tokens and median wall time by the role and worker recorded on each completed run. Each metric needs three applicable samples; unknown token totals remain unknown. The Roles page shows lifetime results alongside definitions and current worker eligibility; Workers shows supply. Routing uses role × worker first-pass yield only when both compared workers have at least three reviewed runs, after role preference and before cost. Producer snapshots publish corresponding fact ids for 24 hours and seven days. See [role result definitions](../workers/012-routing-and-skills.md#role--worker-results) for attribution, review boundaries and sample rules.
