# 041. Live message delivery (`alba say`)

Messages sent with `alba say <TAG> --text ...` or from the console's **Thread** panel are always written to `.alba/inbox.md` in the order's worktree. On supported local engines, Alba also delivers those messages into the running worker automatically instead of waiting for the worker to remember to read the file.

## Delivery by engine

### Claude Code (`claude-cli`)

| Property | Detail |
|---|---|
| Mechanism | Per-run `--settings <state_dir>/runs/<TAG>-<run>.claude-settings.json` with `PostToolUse` and `Stop` command hooks invoking `.alba/bin/inbox-hook.mjs`. |
| When a message lands | `PostToolUse`: right after the next tool call completes (`additionalContext`). `Stop`: before the session exits (`{"decision":"block","reason":"..."}`); never loops when `stop_hook_active` is true and nothing new is waiting. |
| Installed where | `.alba/bin/inbox-hook.mjs` in the worktree (locally excluded via `info/exclude`) and the per-run settings JSON in Alba's state folder. Never writes to `~/.claude` or any user settings file. |
| Verified on CLI | Claude Code `2.1.317`: verified `--settings <file-or-json>` via `claude --help`; hook stdin/stdout contracts tested against `inbox-hook.mjs` subprocesses. |
| Fallback | `.alba/inbox.md` file inbox (and when `live_messages: false` or on remote hosts, no hook or settings file is installed). |

### Antigravity (`agy-cli`)

| Property | Detail |
|---|---|
| Mechanism | Named group `"alba"` merged into workspace `<worktree>/.agents/hooks.json` with `PreInvocation` and `Stop` command hooks invoking `.alba/bin/inbox-hook.mjs`. |
| When a message lands | `PreInvocation`: before the next model invocation (`{"injectSteps":[{"userMessage":"..."}]}`). `Stop`: when the execution loop would terminate (`{"decision":"continue","reason":"..."}`, or `{}` when nothing is waiting). |
| Installed where | `.alba/bin/inbox-hook.mjs` and the `"alba"` group inside `<worktree>/.agents/hooks.json`, both excluded locally via `info/exclude`. Other groups in `.agents/hooks.json` are preserved and left untouched on clean. Never writes to `~/.gemini` or global `.agents`. |
| Verified on CLI | Antigravity CLI `1.5.12`: verified `agy --help` and built-in `hooks.md` schema (`PreInvocation` and `Stop` flat handler arrays, `injectSteps`/`userMessage`, `decision: "continue"`). Headless `agy -p` live hook execution against a live model was not run in tests; the file inbox remains the fallback. |
| Fallback | If `.agents/hooks.json` is tracked in git, Alba does not edit it, records a launch warning, and falls back to the file inbox. |

### Codex app-server (`codex-app`)

| Property | Detail |
|---|---|
| Mechanism | Alba launches `src/workers/adapters/codex-app-run.mjs` under Node, which drives `codex app-server` over JSON-RPC on stdio and polls `.alba/inbox.md` once per second. |
| When a message lands | Mid-turn via `turn/steer` (`{ threadId, expectedTurnId, input }`); after a turn completes (or if `turn/steer` is refused because the turn ended) via `turn/start`. Waits 3 seconds after a completed turn for late messages before closing. |
| Installed where | Runs from Alba's own adapter module; writes only inside the worktree (`.alba/inbox-delivered`) and Alba's state folder / `last_file`. Never writes to `~/.codex/config.toml` or `$CODEX_HOME`. |
| Verified on CLI | `codex-cli 0.167.2`: verified `codex app-server --help` and generated the protocol schema with `codex app-server generate-ts` (`initialize`/`initialized`, `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, `item/started`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`, `error`). |
| Fallback | `codex-cli` (`codex exec --json`) remains unchanged and file-only; Codex exec hooks are not used because they require user-level trust hashes in `~/.codex/config.toml`. |

### Other engines and remote runs

| Engine / mode | Delivery mode | Notes |
|---|---|---|
| `codex-cli` | `file` | Unchanged `codex exec --json`; reads `.alba/inbox.md` per worker rules. |
| `opencode`, `grok-cli`, `script`, custom | `file` | File inbox only; setting `live_messages` emits a config warning and is ignored. |
| Any remote worker (`host` set) | `file` | Remote runs do not install local hook scripts or settings; file inbox only. |

## Message framing and size cap

When a message is delivered by a hook or steered into `codex-app`, each unread, undelivered entry is framed oldest first:

```text
[alba message id=<id> from=<author> at=<ISO time>]
<message text>
After acting on this message, append <id> to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "<id>".
```

- Multiple waiting entries are joined in one payload separated by a blank line.
- One payload is capped at **16 KiB** UTF-8; longer payloads are cut cleanly on a UTF-8 boundary with a note pointing to `.alba/inbox.md` for the full text.
- Concurrent hook invocations claim each entry atomically (exclusive marker files under `.alba/inbox-claimed/`, excluded locally) so an entry is delivered at most once.
- Any error inside `inbox-hook.mjs` prints nothing and exits `0` so the worker is never disrupted.

## Delivery states

Each inbox entry moves through four states in `readInbox`, `OrderDetail.messages`, `OrderDetail.thread`, and the console:

1. **`sent`**: written to `.alba/inbox.md`; not yet delivered or read.
2. **`delivered`**: recorded in `.alba/inbox-delivered` (`{"id":"...","at":"<ISO>","via":"hook|steer|turn","event":"..."}`), with `delivered_at` and `via`.
3. **`read`**: acknowledged in `.alba/inbox-ack`, marked with a legacy `seen <time>` line, the run opened `.alba/inbox.md`, **or** the run's event stream shows model activity (a message, tool call, command, or file change) after `delivered_at`.
4. **`answered`**: an outbox entry has `reply` matching the inbox entry's `id` (or an agent message followed `seen`).

Engines without live delivery stay in `sent` until read, matching earlier releases. If a run ends while a message is still `sent`, it remains unread in the thread and pending notes carry it to the next run.

## Worker setting `live_messages`

```yaml
workers:
  - id: claude-main
    engine: claude-cli
    live_messages: true    # default true for claude-cli, agy-cli, codex-app; false keeps file-only inbox
```

- Default is `true` for `claude-cli`, `agy-cli`, and `codex-app`.
- Setting `live_messages: false` disables hook/steering delivery and keeps the file-only inbox.
- Setting `live_messages` on any other engine is ignored with a configuration warning.
- `alba say` (CLI and `POST /api/orders/:tag/say`) and the console's message box report how the message will travel for the current run: **`live`** (hook at next tool or model call), **`steer`** (`codex-app` direct steering), or **`file`** (worker reads `.alba/inbox.md` itself).

## `codex-app` configuration mapping

A `codex-app` worker uses `launch.program` as the Codex binary (default `codex`) and maps familiar `codex exec` template flags in `launch.args` to `codex app-server` parameters at config load:

| Template flag in `launch.args` | Mapped to |
|---|---|
| `-c key=value` / `--config key=value` | Passed through to `codex app-server -c key=value` (including role MCP `-c mcp_servers.*` overrides). |
| `-m <model>` / `--model <model>` | `thread/start` and `thread/resume` `model` (worker `model` / order model takes precedence). |
| `-s <mode>` / `--sandbox <mode>` | `thread/start` and `thread/resume` `sandbox` (`read-only`, `workspace-write`, `danger-full-access`). |
| `-a <policy>` / `--ask-for-approval <policy>` | `thread/start` and `thread/resume` `approvalPolicy` (`untrusted`, `on-request`, `never`). |
| `--full-auto` | `approvalPolicy: "on-request"`, `sandbox: "workspace-write"`. |
| `--dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: "never"`, `sandbox: "danger-full-access"`. |
| `-C <dir>` / `--cd <dir>`, `-o <file>` / `--output-last-message <file>`, `exec`, `--json`, `--skip-git-repo-check`, `{session_args}`, `{prompt_file}`, `{last_file}`, `{cwd}` | Handled directly by `codex-app-run.mjs` (`cwd`, `promptFile`, `lastFile`, session resume via `thread/resume`). |

Any other flag in `launch.args` that `codex-app` cannot map is refused at configuration load with an error naming the unsupported flag.

`codex-app-run.mjs` translates app-server notifications into the `codex exec --json` event stream (`thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed` with `usage`, `turn.failed`, `error`), so `LiveFold`, `TranscriptFold`, usage accounting, and session resume work identically to `codex-cli`.
