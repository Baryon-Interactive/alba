# 043. Consulting another model during a run

Normally one worker and one model handle an entire run, and a second model sees the work only after delivery ([026](../workflow/026-acceptance-pipeline.md), [039](../workflow/039-first-pass-review.md)). When `consult` is enabled, a running local worker can ask a **different model family** a read-only question inside the same worktree and receive an answer in the same run, counted and visible.

## Why

A worker stuck in its own model's blind spot — a subtle bug it keeps misreading after two tries, a design trade-off with lasting impact, or an artifact its own model cannot read — otherwise burns turns guessing or hands in a weak delivery. Asking a second model family mid-run gives an independent read on the live tree without handing over write authority.

## Configuration

Add `consult:` to `alba.yaml`:

```yaml
consult:
  enabled: true            # default false
  role: consultant         # role whose workers.prefer/only/avoid pick the consultant; falls back to roles.verifier
  max_per_run: 3           # default 3, whole number >= 1
  timeout_minutes: 10      # default 10, positive number <= 30
  kinds: [code, ue]        # optional: only orders of these kinds may consult
```

Unknown keys or out-of-range values fail project validation.

### Choosing the consultant

At local run launch, when `consult.enabled` is `true` (and the order's resolved kind is in `consult.kinds` when set), Alba picks one consultant from `workers.yaml` using the same pool rules as the independent-check reviewer ([026](../workflow/026-acceptance-pipeline.md)):

1. **Role pool**: resolves `roles.<consult.role>` (`roles.consultant` by default), falling back to `roles.verifier` when `consult.role` is not defined, and otherwise considering all local workers.
2. **Launchable and read-only capable**: the candidate must be enabled, available on the local machine (no remote `host`), have a `launch` command, and use an engine adapter that implements `verifierArgs` (`claude-cli` or `codex-cli`; see [worker adapters](../worker-adapters.md)).
3. **Cross-family requirement**: the running worker must declare `model_family` (otherwise consulting is refused for the run with `Set model_family on <worker> to allow consulting another model.`), and the candidate must not be the running worker and must declare a **different** `model_family` (compared case-insensitively).

If no candidate qualifies, the run still starts normally without installing the consult helper and records a launch warning explaining why.

## How a worker calls it

When a consultant is chosen at launch, Alba prepares two things:

- Copies `.alba/bin/consult.mjs` (plus `.alba/bin/consult-origin.json`) into the run's worktree and excludes `.alba/bin/` locally via `.git/info/exclude`.
- Writes `<state_dir>/runs/<TAG>-<run>.consult.json` (mode `0600`, inside Alba's state folder rather than the worktree) with the state path, run key, resolved read-only command line, limits, and a random per-run secret.
- Sets `ALBA_CONSULT=<path to spec>` and `ALBA_CONSULT_TOKEN=<secret>` in the worker's environment, and adds a **Consulting another model** section to the launch prompt (mirrored in `alba-worker-rules`).

Because the helper is a plain Node command rather than an MCP server, every worker engine with a shell (`codex-cli`, `codex-app`, `claude-cli`, `agy-cli`, `opencode`, `grok-cli`, `script`) can invoke it the same way:

```sh
node .alba/bin/consult.mjs --question "<question>" [--file <path>]... [--json]
```

- `--question` (`-q`): non-empty question text.
- `--file` (`-f`, repeatable): relative paths inside the run's worktree for the consultant to inspect first; paths outside the worktree are refused.
- `--json`: prints `{"answer","consultant","model","seconds"}` on stdout instead of plain text.

On success the helper prints the consultant's answer and exits `0`. On refusal, failure, or timeout it prints the reason to stderr and exits non-zero (`1` on refusal or non-zero consultant exit, `2` on invalid CLI flags, `124` on timeout). The consultant's answer is **advice, not an order**: the running worker remains responsible for verifying every claim against the code and tests.

## Limits and daily budget

- **Authentication**: `ALBA_CONSULT_TOKEN` must match the per-run token in `<TAG>-<run>.consult.json` (compared in constant time). Both `ALBA_CONSULT` and `ALBA_CONSULT_TOKEN` are stripped from the consultant child environment.
- **Per-run cap (`max_per_run`)**: at most `max_per_run` non-refused consults may run in a single run (default `3`). Further calls are refused immediately.
- **Per-call timeout (`timeout_minutes`)**: each consult waits up to `timeout_minutes` (default `10`, max `30`), then stops the consultant process tree and exits `124` with outcome `timeout`.
- **Question size**: questions are capped at **4 KiB** UTF-8 in `.consults.jsonl` (and **16 KiB** in the prompt sent to the consultant).
- **Shared daily review budget (`producer.budgets.review_runs_per_day`)**: non-refused consults count against `producer.budgets.review_runs_per_day` **together with** [first-pass reviews](../workflow/039-first-pass-review.md), [independent checks](../workflow/026-acceptance-pipeline.md), and producer review/work runs in the current UTC day. When the daily budget is full, both the helper and new review runs wait or refuse until the next UTC day.

## What the consultant can and cannot do

The consultant runs inside the run's worktree using the exact read-only verifier arguments of its engine:

| Engine | Read-only launch |
|---|---|
| `claude-cli` | `claude -p <prompt> --output-format json --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read,Glob,Grep --allowedTools Read,Glob,Grep --disallowedTools Bash,PowerShell,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task,Skill [--model <model>]` with an isolated `CLAUDE_CONFIG_DIR` under `<state_dir>/review-env/<worker>/claude`. |
| `codex-cli` | `codex exec -C <worktree> --sandbox read-only -c approval_policy="never" -c features.apps=false -c features.plugins=false [-c mcp_servers."<name>".enabled=false ...] --json --output-last-message <file> [--model <model>] <prompt>`. |

- **Can do**: read files, search text, and inspect paths in the run's worktree to answer the question with the order's title and listed `--file` paths in context.
- **Cannot do**: edit, write, or delete files, run shell commands that change state, call MCP tools, browse the web, or commit to git.
- **Worktree integrity check**: the helper hashes `HEAD`, `git status --porcelain --untracked-files=all`, and `git diff` before and after the consultant runs. It never modifies the worktree itself; if the worktree status changed while the consultant ran, the helper warns on stdout/stderr and records `worktree_changed: true` on the consult entry.

## Records, console, CLI and usage

Every consult attempt appends one JSON line to `<state_dir>/runs/<TAG>-<run>.consults.jsonl` with `at`, `question` (capped at 4 KiB), optional `files`, `consultant`, `engine`, `model`, `model_family`, `seconds`, `outcome` (`ok`, `refused`, `timeout`, `failed`), `answer_length`, `answer` (capped at 64 KiB), optional `reason` / `worktree_changed`, and `usage` folded through the engine adapters' `UsageFold` (with estimated USD cost when `price` is configured).

- **CLI**: `alba orders show <TAG>` lists the open or latest run's consults (outcome, consultant/model, duration, question, and any refusal/timeout reason).
- **HTTP API** ([010](../console/010-api.md)): `GET /api/orders/:tag` (`runs[].consults`) and `GET /api/runs/:key` (`run.consults`) include the run's consult list.
- **Console**: the Run page renders a **Consults** panel showing each question, consultant worker and model, timestamp, duration, outcome badge, any worktree-change warning, and the answer inside a collapsible block.
- **Usage and spend** ([020](../console/020-usage-and-cost.md)): `collectUsage`, the Usage dashboard, `orderSpend`, and `spendToday` include consultant token and USD usage on the consultant worker marked with `kind: "consult"` (`consult: true`), counting toward order spend caps and the consultant worker's `daily_cap_usd` without inflating order-run scorecards.
