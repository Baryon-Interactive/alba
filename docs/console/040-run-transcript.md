# 040. Run transcript

`/p/<project>/orders/<TAG>/runs/<run>` shows the full timeline of a worker run on its **Transcript** tab, alongside **Activity** (the bounded [live summary](../workers/019-live-runs-and-messages.md)) and **Raw log** (`LogViewer`). Runs that write a structured JSON event stream default to **Transcript**; plain-text runs default to **Raw log**, and `?tab=transcript|activity|log` selects a tab directly. On the order page, the current running run carries a **Watch** link that opens `?tab=transcript`.

## What the transcript shows

`TranscriptFold` (`src/run/transcript.ts`) turns `run.events_file ?? run.log` into an ordered list of logical `TranscriptEntry` steps (`seq: 0..` in file order, stable for the life of the file) rather than raw JSON lines:

- **`message`**: agent prose rendered as GitHub-flavoured Markdown with raw HTML disabled.
- **`reasoning`**: model thinking / reasoning summaries, dimmed and collapsed to a one-line preview until clicked.
- **`command`**: monospace command title with live spinner (while `running` on an open run), exit code, duration and a copy button; ANSI-coloured output starts collapsed for passing commands and expands automatically when a command fails.
- **`tool`**: tool name, compact `key=value` parameter pills, and collapsible full JSON `input` and ANSI `output` (shown only, never executed).
- **`edit`**: edited file paths with `+/-` line counts and a unified diff generated from `before` and `after` when both exist (never reading the worktree); diffs under 40 lines start expanded and larger diffs start collapsed.
- **`search`**: search query with optional collapsible results.
- **`plan`**: checklist of steps with completion counts.
- **`error`**: error step or stream error in the danger tone.
- **`result`**: final run card with status, message and token/cost usage when reported by the engine.
- **`log`**: up to 200 consecutive plain-text lines grouped into one ANSI-coloured monospace block.

The console renders the list with `@tanstack/react-virtual` (`TranscriptView.tsx`), newest at the bottom. While live it follows the bottom, pauses when the reader scrolls up (offering **Jump to latest**), and pages up via **Load earlier**. Filter chips (**All**, **Messages**, **Commands**, **Edits**, **Errors**), a text filter across titles, body text, command output and edited paths, and a failed-command counter that jumps through failed commands narrow long runs without re-reading the file.

## How each engine's events map to entries

| Engine / format | Event shapes | Pairing and delta rules | Resulting `kind`s |
|---|---|---|---|
| `codex-cli` (`--json`) | `item.started`, `item.updated`, `item.completed` (`agent_message`, `reasoning`, `command_execution`, `mcp_tool_call`, `web_search`, `file_change`, `todo_list`), `error`, `turn.failed` | Paired by `item.id` (`running` -> `done` or `failed`, keeping `seq`). Full `aggregated_output` is kept for passing and failing commands; `file_change` builds a unified diff when `before` and `after` exist; empty `reasoning` items are skipped | `message`, `reasoning`, `command`, `tool`, `search`, `edit`, `plan`, `error` |
| `claude-cli` (`stream-json`) | `assistant` (`thinking`, `text`, `tool_use`), `user` (`tool_result`), `result`, `error` | `tool_use` and `tool_result` pair by `tool_use_id` (`running` -> `done` or `failed`). `Bash`/`PowerShell`/`Shell` map to `command`; `Edit`/`MultiEdit` build unified diffs from `old_string`/`new_string` and `Write` records `after`; `WebSearch` maps to `search`; `TodoWrite` maps to `plan`; `result` carries final text and usage | `reasoning`, `message`, `command`, `edit`, `search`, `plan`, `tool`, `result`, `error` |
| `agy-cli` (`stream-json`) | `event: "step_update"` (`tool`, `agent_response`, `thinking`, `error_message`) and `event: "result"` | Tool steps pair by `step_index` (`ACTIVE` -> `DONE` or failed). Streaming `agent_response` `text_delta` pieces of one `step_index` join into a single `message` (empty tool-only turns are skipped). `run_command` maps to `command`; write/edit/replace tools populate `edit` and unified diffs; `search_web` maps to `search` | `message`, `reasoning`, `command`, `edit`, `search`, `tool`, `error`, `result` |
| `opencode` (`--format json`) | `text`, `reasoning`, `tool_use` (`part.state`), `error` | Parts pair by `part.id` / `part.callID` (`pending`/`running` -> `completed` or `error`). Whitespace-only text parts are skipped; `bash` tools map to `command` and `edit`/`write` tools map to `edit` | `message`, `reasoning`, `command`, `edit`, `search`, `tool`, `error` |
| `grok-cli` (`streaming-json`) | `text` (`data`), `tool_call`, `tool_call_update`, `end`, `error` | Consecutive `text` `data` deltas join into one `message`. `tool_call` and `tool_call_update` pair by `toolCallId` (`in_progress` updates live output; `completed`/`failed` settles state and exit code); `end` emits `result` with usage and cost | `message`, `command`, `edit`, `search`, `tool`, `result`, `error` |
| Plain text (`script`, generic, stderr lines) | Any non-JSON line | Up to 200 consecutive plain-text lines group into one `log` entry with ANSI escape codes preserved in `text` and stripped from `title` | `log` |

Unknown structured events and lifecycle markers (`init`, `thread.started`, `turn.started`, `step_start`, `step_finish`) are ignored without error. Reading the whole file at once or in arbitrary byte chunks produces identical entries.

## Caps, caching and dropping

- **Text and output cap (64 KiB):** each `text`, `output` and edit field keeps at most 64 KiB UTF-8 (the first 16 KiB, a `... [truncated N bytes] ...` marker line, and the trailing ~48 KiB, cut cleanly on UTF-8 codepoint boundaries) and sets `truncated: true`.
- **Parameter cap (16 KiB):** each `input` value over 16 KiB is cut the same way (first 4 KiB, marker line, trailing ~12 KiB) and sets `truncated: true`.
- **Entry cap (5,000 entries):** a run retains at most 5,000 entries in memory. Beyond 5,000, the oldest `log` and `reasoning` entries are evicted first before older commands, edits or messages. Every entry keeps its original `seq`, `dropped` reports how many entries were evicted, and `total` equals `retained + dropped`.
- **Incremental file cache:** `TranscriptRuns` keeps one cache per process keyed by file path, reading new bytes from the last newline offset, leaving any unfinished trailing line for the next read, rebuilding when the file shrinks or rotates, and evicting caches of ended runs that have not been read for 10 minutes.

## Paging and live stream updates

`GET /api/runs/:key/transcript?project=<id>&after=<seq>&limit=<n>` (`limit` default `200`, max `1000`; see [010](010-api.md#reads)) returns `{ project, key, entries, next?, total, dropped, ended }`:

- **Initial tail read (no `after`):** returns the last `limit` retained entries. When earlier retained entries exist before that slice (`startIdx > 0`), `next` is set backwards to `retained[Math.max(0, startIdx - limit)].seq` so the client can page up with `?after=<next>&limit=<n>`; when the oldest retained entry is already included, `next` is omitted.
- **Targeted / incremental read (`after=<seq>`):** returns every entry before `after` whose state is still `running` (so steps that started earlier remain tracked), followed by up to `limit` entries with `seq >= after`. `next` again points backwards when earlier retained entries exist before `after`.

For live updates, `/api/stream?project=<id>&transcripts=<key>@<total>` reuses the hub's scan loop (`src/api/hub.ts`) without adding a per-client timer. Any entry created after `<total>` between the initial read and stream connection is flushed after `hello`, and each subsequent file growth emits `event: run.transcript` with `{ project, key, entries }` containing only the newly added or state-changed entries, which the UI merges in place by `seq`.
