# 019. Live runs and messages

The run page shows a live phase, current command and elapsed time, plan, token counts, recent activity, agent messages, changed files and the order thread. Overview shows the same current activity for every open run. The server folds complete lines incrementally in memory and rebuilds from the event files on restart; the event stream sends changed activity at most once a second per run. Activity keeps 30 entries, ten full agent messages, and only the last 20 output lines of a failed command. Changed files include file events and an asynchronously refreshed git diff against the configured base at most every two minutes. A completed run stores a compact summary on the run in the selected state store.

| Engine | Source and availability |
|---|---|
| `codex-cli` | `codex exec --json`: stdout events in `runs/<TAG>-rN.events.jsonl`; stderr in the existing `.log`. Commands, file changes, plans, messages, turn token usage and errors are folded. |
| `opencode` | `opencode run --format json`: tool uses, text and step token usage when emitted. |
| `claude-cli` | `--output-format stream-json --verbose`: assistant text, tool calls/results, session ids, input/output/cache usage and final reports. Repeated failing tools feed the loop detector. |
| `grok-cli` | `--output-format streaming-json`: tool calls, text, end usage and errors when emitted. |
| `claude-session` | A person starts this card-only session; alba cannot redirect its output. Where a stream file is supplied, assistant/tool events can be read; otherwise the log tail and growth, and the progress receipt, are used. |

The installed command help was checked for each engine. JSON event lines get a receipt timestamp because Codex does not provide one. Unknown events are ignored apart from liveness. A partial last line is held until its newline arrives. Older plain-text logs remain supported. Transient and quota classifiers inspect stderr and JSON error events; loop detection prefers events when present. A configured `dispatch.long_commands` match is waiting for that command until it completes, without being classified as a stall. Other commands do not get this exemption.

`alba status --project a.yaml --project b.yaml [--json]` reads open runs without quota probes; it includes phase, command, plan, event and commit age, tokens and unanswered items. `alba watch TAG` follows recent activity until the run ends; Ctrl+C stops watching. Token counts are reported by the engine; cached input is a subset of input. alba reads the events file as it grows, but `codex exec --json` reports usage only in its `turn.completed` event, and one `codex exec` run is one turn: until the run ends, a Codex run's tokens are not known. `alba status` then says `tokens not reported yet` (JSON: `tokens_reported: false`), and the console shows "not reported yet" instead of 0. Claude stream JSON reports usage per message, so its counts grow during the run. Price estimates use the existing worker pricing when available.

## Conversation

`alba say TAG --text "..."` appends an entry to `.alba/inbox.md` in the worktree, excluded locally from git. Each entry has a stable id and timestamp:

```text
## <id> <ISO time> <author>
reply <outbox id>

Message text
```

The `reply` line is optional. After following an entry, the worker appends its id on a line of `.alba/inbox-ack`. The thread calls it read once acknowledged or an event shows the inbox was opened; a worker can explicitly answer a message with an outbox entry whose `reply` names its inbox id. Old `seen <time>` entries remain readable.

A worker can append a complete JSON line to `.alba/outbox.jsonl`:

```json
{"at":"2026-01-01T12:00:00Z","kind":"question","text":"Which layout?","options":["Grid","List"]}
```

Kinds are `question`, `blocker`, `note` and `eta`. The server polls the file and records entries idempotently, with the time it picked each one up (`received`; a worker's own `at` may be off, and a line without one gets the pickup time). A byte order mark at the start of a line is ignored. Questions and blockers appear in the attention strip as unanswered. Only a **question** makes a running order wait for you (`awaiting-user`) without closing its run or releasing its resources; a blocker or a note while the run goes on is shown, not a stage, and a blocker the worker wrote anything after is past. Reply in the thread, with `alba say TAG --reply <id> --text "Grid"`, or with `alba answer TAG --text ...` (or `--choice N` for the question's options): while the run is open, the answer goes to its inbox as the reply to the newest open question instead of queueing the order behind the run. The worker should continue independent work while waiting, and state a sensible default when one exists. The thread merges inbox, outbox, reports and rework/answer actions by time.

The `--restart` option is still available for an unresponsive worker, but is separate from a normal reply. File and SQLite stores retain the same outbox and run summaries. `templates/skills/alba-worker-rules/SKILL.md` describes the worker-side protocol.

##  report repair and compatibility

When a run ends with an invalid or missing report block, the service records `report-bounced`, writes a repair prompt with the exact report markers and allowed JSON shape, and queues a message for the same worker/session. The bounce is counted separately from `max_resumes`; a second invalid report fails normally.

Before that, a Claude run whose last message has no block is searched for an earlier one. A background command that ends after the final message makes `claude -p` answer its notification in one more turn, and that short answer becomes the last message. The newest valid block of an assistant message after the run's last instruction is then the report; failing that, a report the worker saved with the Write tool to a `*.last.txt` file (some workers write it to a path of their own). The run gets `report_from: earlier-message` or `written-file`, the order a `report-from-earlier` event, and the block's message is saved as the order's final-message file. A last message whose block is invalid is still sent back for repair, and the example block of the prompt never counts. Spacing inside the markers is forgiven (`---  alba-report ---`). The Claude prompt footer asks the worker to wait for or stop every background command before its final message.
