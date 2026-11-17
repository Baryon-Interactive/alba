# 003. Workers and quota

Uses the terms of [001](../concepts/001-concepts.md) and [002](../workflow/002-orders-and-stages.md).

## Why quota matters

Coding agents are paid for in different ways: a subscription with usage windows (for example five hours and seven days), prepaid credits, a local model. Two things go wrong when nobody watches:

- a subscription window is used up, but the gateway keeps sending requests and they quietly spend paid credits instead;
- a worker is offered work although it has nothing left, and the run fails or stalls.

So the tool reads the quota of every worker before it decides anything, and treats "the balance is falling" as a problem to report.

## The workers file

One `workers.yaml` per person or machine (not per project). Its path is given with `--workers` or `ALBA_WORKERS`. Workers describe compute supply: engine, model, route, capabilities, quota, cost and limits. Job knowledge belongs to [roles](012-routing-and-skills.md#routing-worker-groups-and-routes), which can also be shared from this file. The file holds no credentials, only references to environment variables or quota commands.

```yaml
quota_sources:
  gateway-a:
    type: command-json
    command: [example-quota, --json]        # program and arguments, run without a shell
    select: { field: provider, equals: a }  # which items of the output belong to this source
    balance: balance                        # path to a string such as "123.4 credits"
workers:
  - id: coder-a
    engine: codex-cli
    route: free text for people
    paid: true
    concurrency: 2
    daily_runs: 10
    model: example-model       # used for {model} and recorded on the run; otherwise launch.model
    capabilities: [shell, edit, git, long-run, mcp]
    notes: Weekly quota window; large output can exhaust it quickly.
    cost: included              # `included` (inside a plan) or `paid` (billed per use); default: paid when `paid: true`
    skills_mount: [.agents/skills]      # where skills are put in the worktree (default by engine)
    aliases: [Coder]            # words in an order's worker text that mean this worker
    model_family: some-model-1  # free text: workers with the same value are shown as the same model in a different shell
    on_limit: wait              # `wait` (default) or `rotate`: when its usage window is used up or the service is at capacity, hand the order to another worker (document 014)
    rotate_paid: false          # permits a paid handover; the same role's ranking selects the next worker (document 014)
    max_resumes: 12              # consecutive capacity resumes before failing (default 3)
    max_minutes_per_run: 240     # stop a run that goes on longer than this (optional)
    max_usd_per_run: 30          # stop a run whose cost exceeds this (optional)
    trip_after_failures: 3       # this many runs in a row failing without a report pause the worker (default 3, 0 = off)
    trip_minutes: 60             # how long that pause lasts (default 60)
    resume_backoff_minutes: [1, 5, 15, 30] # minutes before each resume; the last value repeats (default [1, 5, 15], about 5 hours for 12 resumes)
    quota: gateway-a
    enabled: true
    disabled_when:
      - { window_full: "7 days" }   # a window with this name (`*` allowed) is used up (default 100 percent)
      - { balance_drop: 5 }         # the balance fell by more than 5 since the previous reading
```

`capabilities` describe what a supply can do. Roles own the required capabilities and preferences; `notes` are display-only text and never affect routing. `skills_mount` says where selected skills are copied. Workers with the same `quota` share a subscription or balance, and route reasons name those peers. `model_family` identifies equivalent models across shells and can be used in role prefer/avoid/only lists, as can ids and aliases. The console and `alba workers set` edit supply fields while keeping comments (document 013).

The documented capability vocabulary is `shell`, `edit`, `git`, `vision`, `web`, `long-context`, `long-run`, `windows`, `mcp`, `fast`, `cheap`, `strong-reasoning`. Free extra tags are valid and listed as `extraCapabilities` in configuration/API views. Matching is exact; a missing capability is never inferred from a model name or notes. An empty list claims no capabilities.

Worker fields `fits`, `kinds` and `profile` are rejected. Put task requirements and worker preferences in roles; use `notes` for descriptive text.

`max_resumes` is the number of consecutive capacity endings allowed on this worker; a different ending resets the count. Actual runs ending with `limit: unreachable` count toward this number and the backoff too; only waits held by an endpoint probe are free (document 005). It accepts an integer from 0 through 50. `resume_backoff_minutes` is a non-empty list of positive integers: resume *k* waits for item *k*, and the last item repeats. For example, `max_resumes: 12` with `[1, 5, 15, 30]` spreads retries over about five hours.

How the tool starts a worker is described by an optional `launch` template (document 005):

```yaml
    launch:
      template: coder-v1              # recorded on each run instead of the command line
      program: coder                  # run without a shell
      model: some-model
      args: [exec, -C, "{cwd}", -m, "{model}", -o, "{last_file}",
             -c, 'sandbox_workspace_write.writable_roots=["{git_dir}"]',
             "Read the UTF-8 file {prompt_file} in full and follow it exactly."]
      env: { DO_NOT_TRACK: "1" }       # values may use {skill_names} and {skill_allow} (document 012)
      env_unset: [SOME_PROXY_VARIABLE]
```

Placeholders: `{cwd}` (the worktree), `{prompt_file}`, `{last_file}` (where the final message goes), `{model}`, `{log}`, `{git_dir}`, `{worktree_git_dir}`. A template holds no key: a program that needs one reads it itself from a file or command that the template only names. The template belongs in the private workers file.

Worker launch removes inherited `ALBA_*` settings and control-plane tokens, then adds explicit adapter/launch values and applies `env_unset`. Application-only settings and control tokens cannot be explicitly forwarded. Ordinary inheritance remains subject to adapter isolation; the Claude adapter below removes unconfigured provider settings. See [the process environment contract](../worker-adapters.md#process-environment) and [privacy](../security-and-privacy.md).

A worker with engine `claude-session` (or `card_only: true`) can only be offered to a person as a card; it is never started by the tool.

## Quota sources

- **`command-json`**: runs the command (no shell, only standard output is read, standard error is ignored) and reads JSON. The output is an array of items, or one object. `select` keeps the items that belong to this source. Several items that remain are treated as interchangeable accounts: a window counts as used up only if it is used up everywhere it exists, and its reset time is the earliest one. Defaults for the field names: `windows` (list), and in each window `name`, `used` (percent used), `resetsAt`. Override with `windows:` and `window_fields: { name, used, resets_at }`. `balance:` is a path to a string; its first number is the amount.
- **`static`**: values written in the file: `unlimited: true`, or `windows:` with `name` and `used_percent`, and an optional `balance`.
- **`codex-sessions`**: the windows of a Codex subscription, read from the session files Codex writes itself (`<codex_home>/sessions/YYYY/MM/DD/rollout-*.jsonl`). After each turn Codex records the account's rate limits there: a primary and a secondary window with the percent used, the window's length and its reset time, and the credit balance. Alba reads the end of the newest files of the last seven day folders and takes the most recent observation; it runs nothing, calls no service and spends no quota. A window is named by its length (`5 hours`, `7 days`), so `window_full: "7 days"` matches it whichever slot Codex uses; a window whose reset time has passed since Codex wrote it reads as 0 percent used. The balance is `<amount> credits`, so `balance_drop` works too. `codex_home` is an absolute folder, by default `CODEX_HOME`, else `~/.codex`; give the folder the worker's launch uses when it sets a `CODEX_HOME` of its own. A missing `sessions` folder is an unreadable quota; a folder in which Codex has not written limits yet (no run so far, or only runs signed in with an API key) gives a reading without windows, so the first run can start.

```yaml
quota_sources:
  codex-plan:
    type: codex-sessions
workers:
  - id: codex-a
    engine: codex-cli
    quota: codex-plan
    cost: included
    disabled_when:
      - { window_full: "5 hours" }
      - { window_full: "7 days", at: 95 }
```

The events file of a worker run (`codex exec --json`) holds no rate limits in the Codex versions Alba has seen, but the same run writes them into its session file, which is what this source reads. The newest observation is as fresh as the last Codex turn on that account, from any program that uses it (a person's own Codex too).

**Claude subscriptions.** Claude Code's `stream-json` output, what a Claude worker's events file holds, carries no usage-limit information (no window, percent or reset time; checked on Claude Code 2.1), so Alba has no built-in Claude reader. Use a `command-json` source that runs a program of your own which prints the windows, for example `[{ "windows": [{ "name": "5 hours", "used": 42, "resetsAt": "2026-11-13T15:00:00Z" }] }]`, from wherever you keep them. The program must not start a Claude conversation to find out (that spends the quota it measures). Or write a `static` source with `windows:` and update it by hand. Without a quota source a Claude worker is limited by its own `daily_runs` and by the capacity endings of its runs (document 014).

Paths look like `a.b[0].c`.

## History and the balance rule

Every tick appends the readings to `<state_dir>/quota-history.jsonl`. `balance_drop: N` compares the new balance with the previous reading of the same source: a fall of more than N switches the worker off and raises a problem. A rise (a refill) is not a drop. Window rules switch a worker off only while the window's reset time is in the future.

If a quota cannot be read, the worker is treated as unavailable (it is not used until its quota can be read) and a problem is raised.

## Machine and project limits

Next to worker limits, the project's `dispatch` section holds the limits of the machine and the project: `caps` (how many orders of a kind, or of a heavy class, may run at once), `min_free_ram_gb`, `stall_minutes`, `rework_reserve`, and where worktrees go. See document 004 for how they are used.

## Engines

The `engine` of a worker says what program the launch template starts. The tool knows six kinds. What differs between them is how a run is started, how it is continued after a drop, and what keeps it from doing more than it should.

| Engine | Started by | Continuing after a transient error | Permissions |
|---|---|---|---|
| `codex-cli` | `codex exec -C <worktree> ... -o <last file> "Read the UTF-8 file <prompt> ..."` in the background | After a service error: a new run in the same worktree with the recovery note (a resumed session was once reset by the same network fault). After a person's answer (document 005): `exec resume <session id>` when the template has `session` arguments, see "A Codex template that can resume". | The template's sandbox settings. A sandboxed run needs write access to the repository's git directories to commit from a worktree (`{git_dir}`, `{worktree_git_dir}`); see document 005. |
| `opencode` | `opencode run --dir <worktree> -m <provider/model> --format json ...` with the prompt pointer as the message | A new run with the recovery note. OpenCode has sessions (`-s <id>`) but chooses their ids itself, and the tool does not read them yet. | Per the program's own permission settings. Its "auto" switch approves everything that is not denied; do not put it in a template. |
| `grok-cli` | `grok --prompt-file <prompt> --cwd <worktree> -m <model> --output-format streaming-json ...`; the output goes to the run's log | The same conversation: the template's `session.resume` arguments (`-r <session id>`) with the recovery note. The tool chooses the session id before the start (`-s <id>`, recorded on the run) and also reads it from the log's end event. | `--permission-mode acceptEdits` and one `--allow 'Bash(...)'` rule per command the work needs (git status, diff, log, add, commit, the project's own build scripts). Never `--always-approve` and never `bypassPermissions`. A command that is not allowed is refused and the run stops there: see below. |
| `agy-cli` | The Antigravity CLI itself, detached: `agy -p "Read the UTF-8 file <prompt> ..." --output-format stream-json --dangerously-skip-permissions --print-timeout 8h --model <model> --add-dir <prompt folder>`, in the order's worktree | `--conversation <id>` after a service failure or a person's answer/message; the id comes from the stream | The account the CLI is signed in with on this machine; tool permissions are skipped as for a headless coding worker. See "An Antigravity worker" below. |
| `claude-session` | Not started by the tool: a person starts it from a card | Not applicable: the person decides | The session's own approvals |
| `claude-cli` | Detached `claude -p --output-format stream-json --verbose --model <model> --permission-mode bypassPermissions`, with the prompt-file pointer, in the order's worktree | `--resume <session>` after a service failure or a person's answer/message; the session id comes from the stream | Runs with the explicitly configured worker environment and its own Claude config directory; bypasses interactive permissions as a headless coding worker. |

### An Antigravity worker

Engine `agy-cli` starts the official Antigravity CLI (`agy`, 1.5.x) directly, with the Google account a person signed it in with (`agy` once in a terminal). Nothing sits between: no gateway, no OpenCode, no other agent CLI. Alba never signs it in.

```yaml
workers:
  - id: agy-direct
    engine: agy-cli
    capabilities: [shell, edit, git, web, fast, cheap]
    concurrency: 1          # one account
    launch:
      template: agy-direct-v1
      program: agy            # or the full path of agy.exe
      model: <an id that `agy models` lists>
      args: []              # the engine adds -p, --output-format stream-json, --dangerously-skip-permissions, --print-timeout 8h, --model, --add-dir
```

Flags the template already has are kept (`--print-timeout 2h`); `--output-format` and `--model` are always set by the engine. agy reads its flags like Go's `flag` package, so a template must not put a bare argument before them.

The stream's lines are keyed by `event` (`init`, `step_update`, `result`); the final message is the `result`'s `response` (or the text after the last tool step), the conversation id resumes the run, and per-step usage is the run's usage (`agy-json`). When agy cannot work, the run ends with a reason of its own instead of "no report block":

| agy says | The run |
|---|---|
| `User location is not supported` (the proxy's exit node is in a region Gemini does not serve) | Resumed like after a transient error; when the resumes run out, blocked with the question to move the exit node |
| not signed in / `UNAUTHENTICATED` | Blocked: sign agy in, then queue again |
| `invalid model selection ... not recognized` | Blocked: set the worker's model to one `agy models` lists |
| quota used up | Blocked, or handed to another worker with `on_limit: rotate` |

Other errors in the result (`503`, `429` without a quota message) are transient errors as for every engine.

### One order on another model

An order can name the model it runs with: `alba orders add <TAG> ... --worker agy-direct --run-model gemini-4-carbon-high`, `alba orders set <TAG> --run-model <id>` (an empty value goes back to the worker's), or the field `model` of `POST /api/orders` and `POST /api/orders/<TAG>/fields`. It replaces the worker's `model` (the `{model}` of its template, and `--model` of the engines that set it) on the worker the order names, or the one a person starts it on with `alba run <TAG> --worker <id>`; a worker routing picks instead keeps its own, since another engine would not know the id. The run records the model it ran with. One worker, so one concurrency slot, can try several models this way.

### An isolated Claude CLI worker

```yaml
workers:
  - id: claude
    engine: claude-cli
    capabilities: [shell, edit, git, mcp]
    concurrency: 1
    cost: paid
    max_tokens_per_run: 500000
    launch:
      program: claude
      model: sonnet
      args: [-p, --output-format, stream-json, --verbose, --model, "{model}",
             --permission-mode, bypassPermissions,
             "Read the UTF-8 file {prompt_file} in full and follow it exactly."]
      env:
        ANTHROPIC_AUTH_TOKEN: '${CLAUDE_WORKER_TOKEN}'
        CLAUDE_CODE_EFFORT_LEVEL: high
```

For a Claude subscription (Pro or Max) instead of a gateway or the API, run `claude setup-token` once and pass the token as `CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN}'`: the worker does not see your own `claude` login (see below), and `alba workers` and every pass warn about a Claude worker that names no sign-in.

Set `CLAUDE_WORKER_TOKEN` in the environment of the process that starts `alba serve`. A `${NAME}` reference in `launch.env` copies exactly that serve-process variable; a missing variable fails the launch without printing its value. Literal values and the existing `{skill_names}` / `{skill_allow}` substitutions also work. To use a configured endpoint, explicitly add `ANTHROPIC_BASE_URL: '${CLAUDE_WORKER_BASE_URL}'` and set that source variable too. Choose a model supported by your provider. Effort is the explicit `CLAUDE_CODE_EFFORT_LEVEL` setting; supported levels depend on the model ([Claude environment reference](https://code.claude.com/docs/en/env-vars)).

Alba sets `CLAUDE_CONFIG_DIR` to `<state_dir>/workers/<worker-id>/claude`; this reserved value cannot be overridden by `launch.env` or `env_unset`. It writes only the named `launch.env` entries (after `env_unset`) into that directory's `settings.json` under `env`, and copies only the order's selected skills into `skills/`. It copies no user settings, credentials, hooks, plugins or MCP configuration. Inherited `CLAUDE_CODE_*` and `ANTHROPIC_*` variables are removed unless explicitly configured. The order's skills are also mounted at `.claude/skills` in the worktree by default, so the prompt's skill paths work. Config and session files stay in the worker's state directory across resumes. Claude documents the directory override in its [environment reference](https://code.claude.com/docs/en/env-vars).

The launcher supplies the required headless, stream-output, model and permission flags, and automatically adds `--resume <session>` when continuing a Claude run; no `launch.session` block is needed. Standard output goes to the run's `.events.jsonl` and standard error to `.log`. Alba reads the session id, last assistant message/report, input and output usage, cache reads and writes, and tool calls/results. Assistant-message usage is counted once; cumulative result usage is reconciled rather than added twice. Final text is saved as `<TAG>.last.txt`. No environment values are recorded in run metadata or launch events.

`max_tokens_per_run` is an optional positive whole number. At the next dispatcher pass after observed usage **exceeds** the cap, Alba stops the run through its process-identity checks, records its usage, and creates a failed report and a `token-cap-stopped` event. This also handles a worker that already exited between passes. The total includes ordinary input, output, cache reads and cache writes. It is an observed-usage stop, so usage can exceed the cap between passes; it is not a provider-side spending limit. Unlike a transient capacity error, a cap stop is left for review and is not automatically retried. The cap is also available to other engines with structured usage. A `codex-cli` run reports its usage only when its turn ends, at the end of the run (see [live runs](019-live-runs-and-messages.md)), so the cap cannot stop a Codex run before it finishes; it marks the run failed afterwards.

`max_minutes_per_run` (a whole number of minutes) and `max_usd_per_run` (US dollars) stop a run the same way: the first once the run has gone on longer than that, the second once its cost exceeds it. The cost is the engine's own figure, or an estimate from the worker's `price`; a run with neither has an unknown cost and is never stopped by this cap. The `token-cap-stopped` event says which cap it was (`kind`: `tokens`, `minutes` or `usd`) and the value. These are the guard against a run that goes on for hours or spends far more than the order is worth: a time cap also stops a Codex run, whose usage is only known at its end.

### When a worker keeps failing: the breaker

A worker whose last `trip_after_failures` runs (default 3; `0` turns the breaker off) all ended failed **without a report block**, the process died, could not start or stopped without saying anything, is paused: it counts as not available, with the reason "paused: its last 3 runs ended failed without a report; one more may try after 14:20", until `trip_minutes` (default 60) after the last of those failures. Then one run may start; if it fails the same way the pause starts again, and any other ending (a delivery, a failed report written by the worker, a send-back) closes the breaker. Cancelled runs, capacity endings, monitor wake-ups and runs alba stopped itself (caps, loops, stalls) neither count nor close it. The breaker looks at the runs of one project.

Such runs also count in the worker's routing history as `failed`, next to `accepted` and `reworked`: a worker whose runs keep dying no longer shows as "100% of 7 accepted".

### A Codex template that can resume

`codex exec resume <id>` takes the model and `-c` overrides but not `-C` or `-s`: the folder is the process's own working directory (the tool sets it) and the sandbox goes in as `-c sandbox_mode="..."`. So the session arguments carry what differs:

```yaml
    launch:
      args: [exec, "{session_args}", -m, "{model}", -c, 'model_reasoning_effort="high"', ..., -o, "{last_file}",
             "Read the UTF-8 file {prompt_file} in full and follow it exactly."]
      session:
        new: [-C, "{cwd}", -s, danger-full-access]       # Codex chooses the session id; the tool reads it from the log header ("session id: ...")
        resume: [resume, "{session_id}", -c, 'sandbox_mode="danger-full-access"']
```

(Checked with a paid gateway provider and `-c model_provider=...` overrides: the resumed session remembered what the first run was told.)

### Codex through a wrapper script

The `codex-cli` engine adds its own flag `--json` (Codex then writes events that alba reads for usage, the session id and the final message) right after the `exec` entry of the arguments. When there is no `exec`, it goes after the first argument, which suits a script that stands in for codex (`node fake-codex.mjs ...`). A template whose `program` is a shell running a wrapper script (`powershell.exe`, `pwsh`, `cmd.exe`, `bash`, `sh`, `zsh`) would get `--json` among the shell's own arguments, and the shell stops at once with a parse error; the run then only says it ended without a report block. Such a template is refused when the workers file is read, unless it says where the flags go with the entry `{engine_flags}`:

```yaml
    launch:
      program: powershell.exe
      args: [-NoProfile, -ExecutionPolicy, Bypass, -File, tools/run-codex.ps1, -Prompt, "{prompt_file}", -LastFile, "{last_file}", "{engine_flags}"]
```

alba replaces the entry with `--json`; the wrapper must pass the arguments it does not know on to `codex exec` (for PowerShell, `codex exec @args ...` with the extra arguments collected in `$args` or a `ValueFromRemainingArguments` parameter). Starting `codex` itself, with `exec` in `args`, needs nothing extra. `{engine_flags}` is an entry of its own (not part of a longer argument) and only for `codex-cli`.

### Tokens and cost

For per-turn accounting, cached-input pricing, usage charts, subscription deltas and advisory budgets, see [019](../console/020-usage-and-cost.md). The aggregate price estimates and spend caps below also work with logs that provide only token totals.

When a run ends the tool reads its log for usage and stores it on the run (older runs are read when asked, and a run without numbers is `unknown`; nothing is guessed):

- Codex: the `tokens used` section at the end: a total only;
- Grok CLI: the `end` event: tokens (with the input/output split), turns and the cost in dollars;
- OpenCode with `--format json`: the `step_finish` events, added up: tokens split in input, output, reasoning and cache, and the cost.
- Claude CLI: assistant-message usage and cumulative `result` usage, reconciled without duplicate counts: input, output, cache reads, cache writes and the total; reported USD cost is retained.

A worker may have `price` (US dollars per million tokens: `per_mtok`, or `input_per_mtok` and `output_per_mtok`) in the private workers file. A run whose engine printed no cost then gets an **estimate**, marked `cost_estimated`. An order's `mandate.spend_cap` (dollars) and a worker's `daily_cap_usd` are checked by the tick: an order whose runs have cost its cap is not started again, a worker whose runs today cost its cap gets nothing more today, and both are reported under PROBLEMS.

### A Grok CLI template

```yaml
  - id: grok
    engine: grok-cli
    aliases: [Grok]
    launch:
      template: grok-v1
      program: grok                      # or the full path of the program
      model: grok-4.7
      args: [--prompt-file, "{prompt_file}", --cwd, "{cwd}", -m, "{model}", --reasoning-effort, high,
             --output-format, streaming-json, --max-turns, "400", --permission-mode, acceptEdits,
             --allow, "Bash(git status:*)", --allow, "Bash(git diff:*)", --allow, "Bash(git log:*)",
             --allow, "Bash(git add:*)", --allow, "Bash(git commit:*)", --allow, "Bash(pnpm test)",
             "{session_args}"]
      session:
        new: [-s, "{session_id}"]
        resume: [-r, "{session_id}"]
```

`{session_id}` is a new id for a start and the previous run's id for a resume; the `{session_args}` entry in `args` is replaced by the matching list. The two go together: a template with one and not the other is refused.

What the tool reads from a Grok log, which holds one JSON event per line plus the program's own messages (both streams are in the log file):

- the `end` event: the session id, why the run stopped (`end_turn`, `max_turn_requests`, `cancelled`, ...), the number of turns and the cost;
- the agent's **final message**: the text after its last tool call. The program has no file for it, so the tool saves it as `<TAG>.last.txt` when the run ended and reads the report block from it;
- the line `permission required: <command> was not run, as a headless run cannot ask for approval`. A run that cannot ask refuses the command and **stops there** (the stop reason is `cancelled`, the exit code is still 0). The tool records the run as failed with a `blocked` report that names the command and asks whether to allow it. It never loosens the permissions by itself: adding an `--allow` rule to the template is a person's call.

Transient errors are looked for only in `error` events and in the program's own plain lines, not in the agent's output, so a test that prints "429" does not look like a rate limit.

### What the permission mode does and does not do (observed with Grok CLI 1.0.70, run without anyone to answer)

- `--permission-mode acceptEdits` on its own did **not** approve an edit: the first edit of a file was refused and the run stopped there (`permission required: Edit <file> ...`). Read-only tools and the commands named with `--allow` ran.
- An `--allow 'Edit(<worktree>/**)'` rule did let the edit through, and an edit of a file outside that folder was still refused (both checked on a scratch repository).
- The tool does not add that rule on its own. A template that has only `acceptEdits` and command rules stops at the first edit, the tick shows the file as a `blocked` report, and a person decides whether to add the edit rule to the template.

## Shared roles

The workers file may define top-level `roles` containing kinds, required capabilities, skills, MCP servers, Markdown rules and ordered worker prefer/avoid/only lists. Projects override these definitions key by key. Every order resolves an explicit role, a kind mapping or a default; without one, it cannot dispatch. Rank is role preference, reviewed role yield, cost, load, then file order. See [Roles](012-routing-and-skills.md#routing-worker-groups-and-routes) for examples, engine adapters and results.
