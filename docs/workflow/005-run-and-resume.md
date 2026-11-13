# 005. Run and resume

Uses the terms of documents 001 to 004.

## Starting an order

`alba run <TAG> --worker <id> [--dry-run]` starts one queued order on one worker. `alba tick` does the same for you (section 4). A held order (for example one stopped with `alba stop`) starts too when the worker is named on the command line or chosen in the console; see [Stopping a run and moving it](#stopping-a-run-and-moving-it). Steps:

0. **Caps and resources.** The order's `resources` must have a free slot, and the project's `caps` for its kind and heavy class must not be full: running and monitored orders of that kind and acceptance runs holding the cap count (the same count the tick plans with). A full cap refuses the start and names who holds it; `--over-cap` (the API's `over_cap: true`) starts it anyway. The tick and the producer's dispatch plan against the caps themselves (with `rework_reserve`). Every start, theirs included, checks the caps and resources again in the same state transaction that records the run and takes its leases, before the worker is spawned: a start that lost the last slot to another start meanwhile is refused and writes nothing (the tick's start may use the `rework_reserve` it planned for that order, no more). An order whose kind is also its heavy class holds one slot of that cap, not two. `alba answer` and `alba say --restart` are checked too: the note is recorded and the order waits in the queue.

1. **Worktree.** One git worktree per order, made from the project's `base_ref`, which must be a local branch (default `refs/heads/main`; a remote-tracking ref such as `origin/main` is refused because it may be stale).
   - Path: `<worktree_parent>/<project id>-<tag in lower case>`. Branch: the same name, unless the order has its own `branch`.
   - If the folder already exists and is on the right branch it is reused; if it is on another branch the run stops.
   - The optional `dispatch.provision` command (a program and arguments, no shell) runs once in a new worktree.
2. **Prompt.** A prompt file in `<state_dir>/runs/` whose first line is a pointer to the order file (`Read the UTF-8 file <path> in full and follow it exactly.`), then the skills table (document 012; a fallback list of the skills copied into the worktree), then the lessons that match the order's tags (document 011), then every note still waiting (a rework, an answer, a monitor result or a message; one keeps its own heading, several are listed oldest first, each with the time it was sent — document 014), then the recovery note if earlier runs exist, then the report footer. Every prompt says **Where you work**: the worktree and branch are the only place to run commands, build and commit, and (for a local run) the main checkout is named as the lead's. Every prompt, a resumed one too, ends with **Slots this run holds** when the order's kind or heavy class has a cap or the order uses a resource: which cap slot the run holds (out of how many, and who else holds one) and which resources, so that a rule such as "build only if you hold the slot" can be followed. The real instructions live in files because non-ASCII text on a command line is mangled on some systems.
   Before the launch the selected skills are copied into the worktree (document 012); a failure there is reported and does not stop the run. `.alba/bin/lock.mjs` is put there too (kept out of git): `node .alba/bin/lock.mjs <name> [--wait-minutes 60] -- <program> <arguments>` runs one command while holding a named lock of the machine (a file in `<temp>/alba-locks`, or `ALBA_LOCK_DIR`; a lock whose holder is gone is taken over: its process ended, its pid now belongs to another process, or its file was left half written; the takeover happens under a second short lock, so two waiters never both hold it, and stopping the helper stops its command before the lock goes back), so orders running side by side take turns. The worker rules use it for game window captures (`capture`): two games on one desktop ended up in each other's screenshots.
3. **Launch.** The worker's `launch` template (document 003) is filled in: `{cwd} {prompt_file} {last_file} {model} {log} {git_dir} {worktree_git_dir} {session_id}`. The process is started in the background, detached, with output going to a log file next to the prompt. On Windows a short-lived helper starts it and exits, so that closing the terminal of `alba serve` does not take the run with it. The pid recorded is the worker's own, except for engines whose output alba captures as events (`codex-cli` with `--json`, Claude stream JSON): then it is the capture wrapper (`src/run/capture.mjs`), and the worker CLI runs under it. When alba stops a run, it checks process creation times and stops verified pids individually. It never uses `taskkill /T`, because Windows can reuse a parent pid while a stale parent-pid field remains on a long-lived child. A lingering stop ends the run's process tree except the job its report hands to the monitor. A step after the spawn that fails (recording the pid, for example) stops what was started and ends the run as `failed`; a run Alba recorded that still has no pid 10 minutes after its start (`LAUNCH_GRACE_MINUTES`; a crash between the record and the spawn) is ended by the tick as `failed`. A run a person opened by hand (`alba orders run-start`) has no prompt file and is left open. `{last_file}` is `<work_orders>/<TAG>.last.txt`, where the worker is told to write its final message. When the work-order folder is inside the repository, `<TAG>.last.txt` and `<TAG>.progress.json` there are named in the repository's `info/exclude` (shared by its worktrees): a worker that commits everything does not put them on its branch, and an untracked copy in the main checkout does not stop a merge. `{git_dir}` is the repository's shared git directory and `{worktree_git_dir}` the private one of this worktree; a sandboxed worker may need write access to both in order to commit from a worktree.
4. **Record.** A Run with the worker, pid, start time, log, final-message file, launch template id, attempt number and, for an engine that can continue a conversation, its session id: the id the tool chose when the template passes `{session_id}` to a new session, otherwise (Codex, which picks its own thread id) none until the engine reports it. The command line is never stored.

A worker that can only take cards (a desktop session) is not started: the command prints that a person has to click a card.

**The base branch is guarded.** Every worker process gets `ALBA_RUN=<TAG>/<run>` in its environment (a remote one too), and a local run installs a `reference-transaction` hook in the repository's shared hooks folder (it covers every worktree). While `ALBA_RUN` is set, the hook refuses any update that moves the base branch (`dispatch.base_ref`): a merge, commit, `branch -f` or `update-ref` of it, from the main checkout or a worktree. Everything else works as before: commits on the order's branch, `git merge main` inside the worktree, other branches, and packing refs (`git gc`). The lead's own commits and merges, and Alba's (no `ALBA_RUN`), pass. A refusal is printed to the worker and appended to `<git-common-dir>/alba-guard.log` (time, run, ref, old and new value, folder). Git updates the files before it updates the branch, so a refused merge in the main checkout leaves its files there (a fast-forward leaves them staged, a merge leaves `MERGE_HEAD`); the branch does not move, and the check below reports the changed files. The hook is rewritten when a run starts and keeps every base branch an earlier install protected. It is not installed when `core.hooksPath` is set or a `reference-transaction` hook that is not Alba's exists; the run then records a warning (`role_warnings`). It stops mistakes, not a worker that unsets the variable.

**Work outside the worktree.** A local run in its own worktree records the main checkout when it starts (the base branch's head and its changed tracked files). When it finishes, alba looks for commits made directly on the base branch during the run (its reflog says `commit`, not a merge or reset) and for files changed in the main checkout since the start. If the run's report lists one of those commits, the worker worked in the main checkout: the delivery becomes `blocked` with what was found (event `outside-worktree`), and a person moves the work to the order's branch and restores the main checkout. Changes the run does not report (the lead's own commit or edit) only give an `accept-warning` event.

## Stopping a run and moving it

`alba stop <TAG> [--note text]` (or **Stop** on a running order in the console, the `stop` action of the interface) ends the open run:

- the recorded process and every process under it (the capture wrapper, the worker CLI and what it started) are stopped, leaves first, each after its creation time is checked against the recorded one (or, when none could be recorded at launch, against the run's launch window: created from 15 s before to 2 minutes after the run's start); a process that cannot be verified as this run is not touched and nothing is recorded; on Linux and macOS a process still there 5 s after SIGTERM gets SIGKILL;
- the run is closed with outcome `cancelled`;
- the order is **held**, so no tick (and no `alba serve`) starts it again.

To move the order to another worker, start it there: `alba run <TAG> --worker <other>` (or **Run now** with the worker chosen). For a held order the release, and a `queue` when the order had ended `idle`, `failed`, `blocked` or `dropped`, are written in the same save as the new run, so a running `alba serve` cannot start it in between on another worker. A held order that waits for a review or an answer is not started this way: release it and decide first. Without a named worker a held order is not started. `alba orders act <TAG> release` hands it back to the tick instead; `alba orders act <TAG> queue` on a held order does the same (a release, and a queue when the order had ended). A worker a person names (`alba run --worker`, **Run now** with a worker) becomes the order's `worker` (event `worker-set`), so a rework or answer the tick starts later goes to it and not to the worker the order was written for; `alba orders set <TAG> --worker <id>` sets it without a run.

`hold` on a running order does the same as `stop`. `cancel` on a running order also stops a verified process tree and closes the run; a process that cannot be verified is left running, as before, and its end is recorded when it exits. `alba orders run-end <TAG> --outcome cancelled` only records the end of the run (it does not touch processes); because a person ends a run as cancelled to take it out of the work, it also holds the order. `alba orders run-end <TAG>` (outcome `completed`) on a run whose log already ends with a valid report block records that report too, as the end of the process would have. Stalled and looping runs (`dispatch.on_loop: stop`) and runs over `max_tokens_per_run` are stopped the same way, the whole tree.

## The report block

A worker ends its final message with:

```
--- alba-report ---
{"status":"ready","summary":"one sentence","question":"","evidence":["path"],"commits":["abc1234"]}
--- end ---
```

The same JSON can be a `<TAG>.report.json` file in the work-order folder. Statuses: `ready`, `waiting` (one question), `blocked`, `failed`, `dropped`, and `progress`. Opening a branch or writing a report is not the same as being done: `ready` means it was checked against the acceptance criteria. `templates/report-footer.md` is the English text to append to any order prompt; `alba run` appends it automatically.

## Noticing that a run ended

The tick looks at every run the tool started. If its process is gone:

| What it finds | What is recorded | Stage afterwards |
|---|---|---|
| a report block (in the final-message file or `<TAG>.report.json`, written after the run began) | run `completed`, and that report | by status: `ready` gives `awaiting-review`, `waiting` with a question gives `awaiting-user`, and so on |
| no report, and the end of the log shows a transient service error (model at capacity, 429, 5xx, connection reset, stream disconnected, lost conversation state) | run `capacity` | `queued`, resumed after a backoff |
| no report, and the worker's model endpoint is unreachable (status-less Claude retries with only synthetic output, or a connection error for its base URL) | run `capacity`, `limit: unreachable` | `queued`, held until a 3-second TCP probe succeeds |
| no report, any other ending | run `failed` and a failed report | `failed`, waits for a person |
| no report block in a file, but the log of an engine that has no final-message file ends with a final message that has one (document 003, Engines) | run `completed`, that report, and the message saved as `<TAG>.last.txt` | by status |
| no report, and the engine refused a command it may not run and stopped | run `failed` and a `blocked` report that names the command and asks whether to allow it | `blocked`: a person decides |
| a final agent message without a report block, or an invalid report block | run `completed`, with one automatic report-repair restart; a second unrepaired ending fails | `queued` for repair, then `failed` if repair fails |

A final-message file older than the run is ignored. A run that is still alive is never touched; if it has no new commit, no log growth and no report for `stall_minutes`, the tick reports it as stalled and leaves the process running.

**New work takes precedence over report repair.** The report-only repair instruction (check `git log` and print only the report block) is used only when no pending person or producer note is newer than the run that missed its report. Queue notes, rework, answers and messages all count, including notes sent while that run was still open. With newer work pending, the normal continuation prompt includes those notes and only one reminder: “The previous run ended without a report block; end this run with one.” This also applies when the note arrived after repair was queued, and survives transient retries. An older note by itself does not replace report repair.

**A monitor result continues the work.** When a monitor ends (success, failure, deadline or refusal), its result, output and the worker's saved note are inputs to the remaining work and acceptance checks. Both a resumed session and a new session are told to continue that work; even a missing-report repair of a monitor follow-up must carry that instruction rather than report-only instructions. If the follow-up ends with only a `progress` report, its notes stay pending and it gets one automatic continuation on the same worker. If that continuation also ends with `progress`, the tool records a failed report and opens a producer case. It does not silently leave the order idle. New instructions sent by a person during the follow-up keep their own queued continuation.

The [continuation repair tests](../../test/continuation.test.ts) links the three complete prompt examples checked by fake-engine tests.

## When the model endpoint is unreachable

A local gateway or relay with nothing listening is not the provider being full. The tick still records outcome `capacity`, and sets `limit` to `unreachable`, when either of these is true:

- every Claude `api_retry` event has no HTTP status (`error_status` null), and the run produced no real model output (only `<synthetic>` messages, and zero usage);
- the end of the log shows a connection error (`ECONNREFUSED`, `connection refused`, Windows `actively refused` / `os error 10061`, `could not connect`, `fetch failed`, `ENOTFOUND`, `getaddrinfo`) naming the worker's own host and port, even after real output. JSON tool output is ignored; only event error fields count.

The reason names `host:port` from `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or a `base_url` override in the launch env or arguments. Without a known base URL, status-less retries stay plain `limit: capacity`. Tokens and command lines are not recorded. Report repair, blocked commands and the turn limit take precedence over endpoint detection.

Before the next resume, or a new start, on a worker whose last run ended this way, the tick refreshes a TCP probe in the background with a 3-second timeout. Probe answers, including failures, are cached per worker and endpoint (5 seconds for direct ticks; the board/API use their probe-cache TTL). Pages and recurring ticks never wait for a probe, even on the first read; an unknown answer holds the worker until the probe completes. One-shot `alba tick` (including dry runs) and `alba workers` await the asynchronous probes before deciding, so each fresh CLI process can detect recovery. If a probe fails, the order is held with `endpoint <host:port> is down`, one problem is raised for that worker, and `alba workers` marks the worker unavailable with `endpoint unreachable`. These waits do not count toward `max_resumes` and do not hand the order to another worker. Actual run failures count toward the cap and transient backoff, including a run that fails again after the probe passes. The board, `alba status`, and the producer say `endpoint unreachable`. When the probe answer says the port accepts a connection and backoff is over, the order starts again.

An HTTP 429 or 5xx retry among the last 15 non-empty event lines stays `limit: capacity`: the provider answered, and it was full. Earlier retries in a long run do not override a later connection loss.
## Resuming after a transient error

The tick resumes such an order in the same worktree, up to three times in a row, waiting 1, 5 and 15 minutes after each failure. If the template has `session` arguments the resume continues the same conversation (`session.resume`), unless the service lost the conversation; otherwise it starts a new session. The new run's prompt carries the **recovery note** (`templates/recovery-note.md`): look at `git status`, `git log` and the files first, keep finished work, do not repeat actions that reach outside the directory. The run records `attempt` 2, 3, 4 and why a new session was needed. The next transient failure after the third resume gives up: the order becomes `failed` and a person decides. A person who queues the order again starts a fresh run in the same worktree (with the recovery note, since earlier runs exist).

**Which session is continued.** A resume (after an answer, a message, `say --restart` or a transient failure) continues the session the engine reported in the previous run's events (Codex `thread.started`, Claude `session_id`); the id on record is used only when the events have none. A run stopped by a person is closed before its end is read, so before this its record could hold an id the engine never used, and every resume failed. A resume the engine refuses because the conversation is gone (Codex `no rollout found for thread id`, Claude `No conversation found with session ID`) counts as a lost session: the run ends `capacity`, and the next start is a new session whose prompt carries the order and the pending messages. A person who queues the order again after a message, or starts it on another worker, also gets a new session with the order and the messages, not the old conversation.

**Answering a question.** A worker that needs a decision ends with a report whose status is `waiting` and one question; the order is `awaiting-user`. `alba answer <TAG> --text ...` (or the board) stores the answer and starts the same worker again at once. If its launch template has `session` arguments, the previous run's session is resumed and the prompt holds only the answer and the report footer; the session id is the one the tool chose (Grok CLI) or the one the engine printed (Codex: `session id:` in the log header, read when the run ends). Otherwise a new run starts in the same worktree and its prompt carries the order pointer, the question and the answer.

`alba prompt <TAG> [--out file]` prints the prompt file the tool would write for an order (the pointer, every note still waiting with its time, the recovery note if the tool ran it before, the report footer), for a person who starts the worker by hand but wants the report block. A note stays until a later run ends completed with a real report, ends monitoring, or is stopped by a person (document 014).

## The real tick

`alba tick [--max-dispatch n]` (default 1):

1. records ended runs as above;
2. starts due resumes, and at most `n` new orders, one at a time; before each start quota and machine resources are read again, because they change between ticks. The cap is per tick: under `alba serve` every run end and every trigger more than 3 seconds after the last one is a tick of its own, so several ends spread over a minute can start several orders;
3. prints the same report as the dry run, with a DONE section for what it did. Exit codes are those of document 004.

A start that fails (no order file, no launch template, git error) becomes a problem in the report and exit code 2.

## Sandboxed workers and git worktrees

A worker that runs in a file-system sandbox has to commit from a worktree, which writes into the repository's shared git directory (`{git_dir}`) and the worktree's private one (`{worktree_git_dir}`). On at least one setup (Windows, a sandbox in "workspace-write" mode) the private directory stayed read-only even when both were listed as writable roots, and the worker finished with a `blocked` report whose question asked for write access. The tool records that report like any other. What to do is the person's call: change the sandbox setting of the launch template, or commit the finished work as the reviewer and record a `ready` report that says so.

## Merging after the base moved

`review approve` needs the branch to be part of the base branch. If the base branch moved on after the worktree was made, a fast-forward is not possible: rebase the branch onto the base first, then merge.

## A worker that waits for a long command

A worker may sit in front of one command for hours (a remote scenario run) while its log and git do not change. For Codex logs the tool can see this: the log prints `exec` and the command when it starts and the result line (` succeeded in ...`, ` exited N in ...`) only when it ends, so a command with no result line is still running. A quiet run in that state is shown as `waiting for a command: <first 60 characters>, N min` in its own section and is not a problem. Only after `dispatch.long_command_minutes` (default 240) does it become a stalled-run problem. Other engines' logs are not read for this yet, so they are judged by `stall_minutes` alone.

Lines such as `ERROR codex_core::util: OutputTextDelta without active item` and a failed refresh of the model list are noise in Codex logs. They are never read as transient service errors.

## Project file extras

`workers: <path>` in `alba.yaml` names the project's workers file (`--workers` and `ALBA_WORKERS` win). `dispatch.long_command_minutes`, `sync` (document 008) and the table keys `needs_markers` and `base_pattern` (document 002) are described where they are used. An order with a `base_ref` gets its worktree from that local branch instead of the project base.
