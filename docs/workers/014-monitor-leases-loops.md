# 014. Long jobs, shared resources, loops, hand-over and start receipts

Five things that keep a worker from holding a slot for nothing, or from wasting a run. They were added together (). Read documents 002 (stages), 004 (the tick) and 005 (runs) first.

| What | Keys and commands | Default |
|---|---|---|
| A long job is handed to the monitor | report `status: "monitoring"` with a `monitor` object; stage `monitoring` | always available |
| Shared resources and leases | `resources` in the project file, `uses` on orders, `alba resources`, `alba leases` | no resources declared |
| Loops and idle runs | `dispatch.on_loop`, `loop_*`, `long_commands`, `alba loops` | report only |
| Stalled runs | `dispatch.stall_minutes`, `dispatch.on_stall` | report only |
| Hand-over when a worker runs out | `on_limit: rotate` on a worker | `wait` |
| Start receipt and step list | `<TAG>.progress.json`, `dispatch.start_receipt_minutes` | 15 minutes |

## 1. The monitor: a long job does not hold a slot

A worker that starts something long (a package step, a remote simulation, a render) and would only wait for it should not sit in a slot, nor burn quota while it waits. It ends its round with a report that says so:

```
--- alba-report ---
{"status":"monitoring","summary":"the package step runs on its own","monitor":{
  "check":["python","tools/package_status.py","--json"],
  "cwd":"../worktrees/pk1",
  "done_when":{"file_exists":"Saved/Packaged/WindowsClient/Game.exe"},
  "fail_when":{"output_matches":"FATAL|package failed"},
  "deadline_minutes":240,
  "note":"When it is done, run the smoke test and report."}}
--- end ---
```

- `check` is a program and its arguments (no shell). It must only read: it is run by the tick, not by the worker.
- A condition is exactly one of `exit_code` (the check exits with this code), `file_exists` (a path, relative to the check's folder) or `output_matches` (a regular expression on the output). `done_when` is required, `fail_when` is optional, `deadline_minutes` is 1 to 10080.
- `cwd` must be the order's worktree, the project folder or a folder named in `dispatch.monitor_dirs` (relative paths there are resolved against the project file). A check that wants to run anywhere else is refused: the order goes back to its worker with that as the reason. `dispatch.monitor_timeout_seconds` (default 120) stops a check that hangs; the end of its output is kept.
- Optional `pid` identifies the background job. The report records its OS process creation time with the PID; this distinguishes PID reuse from the original job. When that process has ended (or its pid now belongs to another process), the next check decides: `done_when` or `fail_when` as usual, and when neither holds the job ended without success and the order goes back to its worker as `failed` ("its process (pid N) is gone and neither condition you gave was met"). A job that exits when it is done is therefore handed back at the next tick; before, a monitor whose job had exited was never checked again.
- One monitor per order. A new `monitoring` report replaces the old one.

The order's stage is `monitoring` (document 002). It has no open run, so it holds no worker slot, and the run that ended is not counted against the worker's runs of the day. A continuation run started after a monitor is not counted either.

Each tick runs the check of every monitored order (`alba tick --dry-run` shows them under MONITORING without running anything; the real tick runs them). The result is stored on the order: the number of checks, the time and result of the last one, the end of its output. The event log gets one `monitor-check` event per change of result, not one per check.

When the condition is met, the failure condition is met, or the deadline passes, the order is queued again with a `monitor` action and the **same worker continues the same session** when the engine can resume. Its prompt carries what the monitor found, the end of the output and the worker's own `note`. A continuation goes before new orders in the tick's order. If the engine cannot resume, a new run starts with the same prompt.

The skill `alba-worker-rules` tells workers when to use this and how (section 5 of the skill).

### Stale monitors and repeated producer retries

`staleMonitor` still names a dead PID, a different creation time, or a creation time later than monitor start as identity evidence, but the monitor pass (the tick's and an enabled producer round's) now hands such an order back to its worker as described above instead of leaving it to a `monitor-stale` case. A check that keeps returning identical output and unchanged named-file timestamps for `monitor.stale_minutes` (default 45) also opens the case. Named files include file criteria and paths in command arguments/output. Output, exit/error/timeout state and file timestamps form a digest; changing any restarts the inactivity clock. These checks also run when the automatic tick interval is zero. The default producer action is proposed `rework`, carrying the evidence and an instruction to inspect or repair the job/check. An unchanged case is not sent repeatedly.

Before producer `queue`, `rework` or `answer`, the host compares the last two failed run outcomes using the existing cause classifier and the last two completed producer notes. Two matching causes require a new note that names the cause and a different concrete fix. Repeating the note or remedy records a `producer-refused` event with `same cause twice: change the approach or ask a person`. This gate runs both at proposal and execution. `hold` and `ask` remain available. A successful delivery breaks the failure streak.

## 2. Resources and leases

Some things are scarce in a way the per-kind caps (`dispatch.caps`) cannot say: a Windows build machine that takes three jobs, a packaging lane that takes one, a benchmark that needs the machine to itself. Declare them in the project file:

```yaml
resources:
  build-box:        { slots: 3, note: "builds on the dev box" }
  package-lane:     { slots: 1 }
  perf-exclusive: { slots: 1, exclusive: true, blocks: [build], lease_minutes: 240, match: "frame[- ]time|perf run" }
```

- `slots`: how many leases at a time. `note`: shown in the console.
- `exclusive`: while it is held no order of a kind in `blocks` (default `[]`) is started, and an order that uses it waits until no such order runs.
- `lease_minutes` (default 480): a lease older than this is listed as a problem.
- `match`: a regular expression; an order whose title, condition or work-order text matches uses this resource without saying so.

Orders say what they use by hand (`alba orders add --uses a,b`, `alba orders set TAG --uses a,b`, the field `uses` in the interface) or by rule: `kind_rules` of the dispatch table take `uses: [...]` like `kind` and `heavy`, and are applied when the table is imported. `--uses` refuses a name the project does not declare; an order that already uses one that is not declared (a rule from the table, a file edited by hand) is held back by the tick with that as the reason.

A lease is **taken when the run starts**, in the same state transaction that checks the free slots and the kind caps again and records the run, before the worker is spawned: a tick and a person's `alba run` (or the console's **Run now**) can no longer both take the last slot. A start that finds the slot taken by then is refused and writes nothing (the tick's own starts are checked against the cap plus the `rework_reserve` it planned for that order). A lease is **kept while the order runs or is monitored** (a monitored order still occupies the machine its job runs on). It is **released** when the run ends for good (the order is awaiting review, failed, cancelled, merged…) or its process is gone. The tick decides that under the state lock (orders and leases read and released in one transaction), so a start of the same order at that moment is never released from under it. An order that cannot get all its leases stays queued and the tick says why in `heldBack` ("resource build-box is full (3/3, held by A, B, C)"). Planning counts leases the same tick has already promised, so two orders do not take the last slot together.

A lease that outlived `lease_minutes` while the order is still running or monitored is listed as a `lease-expired` problem. The console's resources area (next to the workers) shows each resource with its slots and holders, and a **Reclaim** button on an expired lease; the same from the command line:

```
alba resources                            # slots, holders, held minutes
alba leases release <resource> <TAG>      # a person takes a lease back
```

`GET /api/resources` and `POST /api/leases/release` are the interface (document 010). Releasing records a `lease-released` event. There is no remote executor: a resource is a name to count against, not a place a job is sent to.

## 3. Loops and idle runs

The tick reads the log of each running order (Codex rollout or alba logs, Grok `streaming-json`, OpenCode events) and lists the commands the worker ran. It reports a `looping` problem, with the evidence, when:

- **repeat**: the same command failed with the same error (digits and colours removed) at least `dispatch.loop_repeat` times (default 3), or the same command failed more than that many times in a row (the error text of a failing remote command often differs slightly);
- **alternate**: two commands took turns for at least `dispatch.loop_alternate` rounds (default 6), and more than half of those runs failed;
- **idle**: the log kept growing but there was no new command and no new commit for `dispatch.loop_idle_minutes` (default 45). This needs two looks of the tick: it remembers the command count and the log size in `state/_watch.json`.

A command that failed only because a search program found nothing (`grep`, `rg`, `findstr`, `diff`, `cmp`, `test` exiting 1) is an answer, not an error. Long commands containing a word from `dispatch.long_commands` (default `[]`; set this list explicitly for each project) never count towards *idle* or *alternate*: a worker waiting for a build is not stuck. They still count towards *repeat*: the same build failing the same way three times is a loop.

`dispatch.on_loop` is `report` (default: the problem is listed, nothing else happens) or `stop`: the run is killed, ended as `stalled`, the order gets a `failed` report that carries the evidence, and a `loop-stopped` event is recorded.

`alba loops [TAG] [--all]` reads the logs of open runs (every run with `--all`) and prints, per run, how many commands it ran, how many failed and what it found; for Codex logs, which carry timestamps, it also lists gaps longer than `loop_idle_minutes` between two commands. It changes nothing. Use it to see what the rules would say about runs that are over.

### A run that stalls

A run with no commit and no new activity for `dispatch.stall_minutes` (and no long command still open) is the `stalled` problem. `dispatch.on_stall` is `report` (default: only the problem) or `continue`: the tick stops the run's process tree with the same identity checks, saves its uncommitted files in a WIP ref (the files stay in the worktree), ends the run as `stalled` and queues one continuation on the same worker whose note tells it to commit what is there first and run long builds in the background (event `stall-stopped`, `continued: true`). If the order stalls again before a person acts on it, the run is stopped the same way but not continued: the order gets a `failed` report and a person decides. This is the answer to a run that hangs in the night and is found five hours later.

### A run that has delivered but whose process stays

Sometimes a worker prints its final message and report block and then its process does not exit (a Codex process was seen waiting two hours after the block was in its log). The tick says so: when the end of a run's log is a complete, valid report block (`--- alba-report ---` to `--- end ---`; for engines that print JSON events, the text of the final message), nothing but a short trailer follows it, it is not the example block of the report footer printed back with the prompt, the process is still alive and the log has had no new output for `dispatch.lingering_minutes` (default 10), the problem is `lingering` ("the run has already handed in its report ... but its process is still there") instead of "no commit for 2 hours".

`dispatch.on_lingering` is `report` (default: only the problem) or `stop`: the tick ends that run's process tree (the recorded process, often the capture wrapper or the editor helper, the worker under it and what the worker left running) except the job its delivered report hands to the monitor (`monitor.pid`, with what is under it), and records the end like any other: the report is read from the final-message file, or, when the process was stopped before the engine wrote it, from the block at the end of the log (event `lingering-stopped`). The same fallback applies to any run whose process is gone and which has no final-message file but a block at the end of its log.

When the last event in the log is the engine's own end of the run (Codex `turn.completed`: `codex exec` runs one turn; or an `end` event), the worker has said it is done, and nothing else would end the run: `codex exec` was seen staying after its last event while an MCP server would not let go. Then 2 minutes of quiet are enough (`ENDED_GRACE_MINUTES`, or `lingering_minutes` if shorter), the problem reads "the worker ended its turn and handed in its report ...", and the tick stops the process tree as above whatever `dispatch.on_lingering` says. Claude's `result` event does not count: `claude -p` may start another turn for a background command's notification. `alba status` shows such a run as "turn ended, report handed in (ready); process still running" (or "report handed in" without an end event) instead of its last activity.

alba never uses `taskkill /T`: Windows retains a child's parent pid after that parent exits, and may reuse the pid for an unrelated process. Windows cancellation and loop stops take one process snapshot, verify the root's recorded OS creation time, and walk only children created at or after their parent, stopping leaves first by individual pid. A lingering stop verifies the same identity and records the pids it spared in `lingering-stopped.left_running`. A run whose OS creation time could not be recorded at launch is identified by its launch window instead: a live process with its pid counts as the run's only when it was created between 15 s before and 2 minutes after the run was recorded as started (the run is recorded just before its process is spawned); anything else is refused. On Linux and macOS each verified process gets SIGTERM, and SIGKILL 5 s later if it is still the same process.

The rules are heuristics read from logs, not from the process. The OpenCode reader follows that engine's event format and has so far only been tested on made-up logs.

## 4. Handing an order over when a worker runs out

A worker can say what to do when its usage window is used up or its service is at capacity:

```yaml
workers:
  - id: coder-a
    on_limit: rotate      # wait (default) | rotate
    rotate_paid: true     # optional: a hand-over may go to a worker whose cost is paid (default false)
```

With `wait`, nothing changes: a capacity error is resumed after a backoff (document 005), a used-up window shows up as the worker being unavailable (document 003).

With `rotate`, a run that ends with a capacity error, or with a "usage limit / quota exceeded / out of credits" message at the end of its log, ends with outcome `capacity` (and `limit: quota` or `limit: capacity` on the run). The next tick chooses another worker for the same resolved role without waiting for backoff. A run with `limit: unreachable` is not a hand-over: the endpoint was not answering (document 005), so the tick probes it and waits, even when `on_limit` is `rotate`. Required capabilities and avoid/only lists still apply; ranking remains ordered role preference, reviewed role yield, cost, load and file order. The exhausted worker is excluded. Paid targets require `rotate_paid: true`, a paid exhausted worker, or a positive order mandate `spend_cap`.

If qualifying targets are busy (at concurrency or with used-up windows), the order **waits**. Resuming the exhausted worker happens only when no qualifying rotation target exists, after its backoff. Later orders use the normal role ranking and availability snapshot. Nothing moves an order that is already running.

The event and the order detail say `handed over from X to Y because X was at capacity` (or because X ran out of its usage window), and whether the target is paid or included.

The new worker starts in the same worktree on the same branch, in a **new session** (another engine cannot continue the first). Its prompt is one line: the path of a continuation file, `state/runs/<TAG>-<run>.handoff.md`, which holds why the hand-over happened, the order file, the commits on the branch since the base, uncommitted changes, the last report, questions asked and answered and notes still waiting, the end of the last log, and then the usual instructions and report footer. The run records `rotatedFrom` (worker, reason, whether the target is paid, and the sentence) and the file; a `run-rotated` event carries the same sentence, and the console shows it on the runs of the order and in the tick.

## 4b. Notes stay until a run has followed them

A rework note, an answer, a monitor result or a message (`alba say --restart`) counts as followed only when a run that **started after it** ends with `completed` and a real report block (a monitoring report counts), or a person stops that run (`cancelled`). A capacity or other transient ending does not count, and neither does a run that failed to start or a report that was only inferred. Until then every later run gets the note again, including a resume and a run on another worker after a hand-over. Several pending notes all go in the prompt, oldest first, each with the time it was sent. `alba orders show` and the order page list the ones still waiting.

## 4c. Messages and the commit reminder

`alba say <TAG> --text <message>` (and the Message box on the order page) appends the message, with the time and who sent it, to `.alba/inbox.md` in the run's worktree. That path is added to the worktree's `info/exclude`, not to the repository `.gitignore`. The order page shows whether the worker has marked a message seen.

The worker rules say to read that file after each commit and at least every 15 minutes, follow new messages, and append `seen <time>` under each one.

`--restart` is for when the worker does not read the inbox in time. It stops only a process the tool started: the recorded pid must still be alive and its OS creation time must match the one recorded at launch. Anything else is refused and left running. Then the run is recorded as stopped by a person and a new run carries the message as a note (section 4b). When the engine can resume its session, that session continues with the message; otherwise it is a fresh run.

`dispatch.commit_nudge_minutes` (default 45, `0` off) is a real-tick reminder. When a run has changed files and no commit for that long, one inbox message is written: `You have N changed files and no commit for M minutes: commit (work in progress is fine), then go on.` The next one waits another full period. After the second, while the tree is still dirty, the order shows it as a finding and Needs you lists a `commit-nudge` problem. A dry run does not write a reminder; it does show one that was already sent twice.

## 5. Start receipt and step list

Right after it starts, a worker writes `<TAG>.progress.json` in the work-order folder, and replaces the whole file as the work moves on:

```json
{"plan":[{"step":"read the order","status":"done"},{"step":"write the loader","status":"doing"},{"step":"test","status":"todo"}],"note":"halfway"}
```

The file is the receipt (the worker is alive and has a plan) and the progress (the console shows "step 3/7" on the board card, with the step in hand; the order page lists the steps). Statuses: `done`, `doing`, `todo` (other words are read as not done).

If a run has no receipt written after it began and no commit since it began, after `dispatch.start_receipt_minutes` (default 15), it is listed as a `start-failed` problem. That is earlier than `stall_minutes`, which waits for commits. A receipt left from an earlier run does not count for a new one. A run that wrote nothing but is working fine just has to write the file; the skill `alba-worker-rules` says so (section 6).

## 6. Where to look

| Question | Where |
|---|---|
| Which orders are monitored and what did the last check say | `alba tick --dry-run` (MONITORING), the board column Monitoring, the order page |
| Who holds what | `alba resources`, the Workers page |
| Is a run going round in circles | `alba loops`, Problems on the first page |
| Why did another worker take the order | the runs of the order, `run-rotated` in its timeline |
| Did the worker start | the step count on the card, `start-failed` in Problems |

## 7. Named locks and resources

Use `alba lock <name> -- <program>` when two orders must take turns at one machine-wide thing, such as one game window or one screenshot capture. A lock is a short mutual-exclusion turn and does not consume a project capacity. Use a project resource when the work consumes a counted machine or service slot, needs a lease in the console, or must block a class of work. `alba resources` shows both resource leases and held named locks; named locks include the holder, command, folder, minutes held and a stale flag. `alba lock list` shows the same machine-wide lock directory without loading a project.

## 8. WIP refs for abnormal ends

When a run ends with any `end.kind` other than `report` (document 005, [How a run ended](../workflow/005-run-and-resume.md#how-a-run-ended)) and its worktree has uncommitted or untracked (not ignored) changes, Alba snapshots that work into `refs/alba/wip/<TAG>-<run>` without touching the working tree, the real index, or `HEAD`:

1. A temporary `GIT_INDEX_FILE` is seeded with `git read-tree HEAD`.
2. Modified and untracked paths are staged into that temporary index (`git add -A`), skipping any single file over 50 MB and stopping once total staged bytes would pass 500 MB (`wip_skipped: true`, with up to 20 skipped paths recorded in `wip_skipped_paths`).
3. `git write-tree` and `git commit-tree` create a commit parented on `HEAD` naming the order, run, and `end.kind`, and `git update-ref` points `refs/alba/wip/<TAG>-<run>` at it.

Alba never runs `git stash`, never deletes `refs/alba/wip/*` automatically (including during `alba clean`), and never fails a run finish if the snapshot fails (recording `wip_error` on `Run.end` instead). `alba orders show <TAG>` prints the ref, file count, and how to inspect or restore paths from it:

```
git show --stat refs/alba/wip/<TAG>-<run>
git checkout refs/alba/wip/<TAG>-<run> -- <path>
```
