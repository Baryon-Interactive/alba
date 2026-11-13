# 004. Tick

`alba tick --dry-run` is one decision pass. It only reads and decides: it starts nothing, creates no worktree and sends no message. The only file it writes is the quota history (use `--no-record` to avoid that too). Without `--dry-run` the tick acts on its decisions; see [005](005-run-and-resume.md).

## What it does, in order

1. Reads all orders and their stages.
2. Reads quota for every worker and the machine: free memory, and for each running order the last commit time and the number of uncommitted files of its worktree. The worktree is the one recorded on the order, or else a git worktree of the project whose folder or branch name contains the order's tag as a whole word. It also looks for `<TAG>.last.txt` in the work-order folder.
3. Finds problems:
   - **stalled**: a run is open and the newest sign of life is older than `stall_minutes` (the last commit, or the start of a real run);
   - **maybe finished**: the final report file of a running order is newer than its last commit, so the worker has probably said it is done;
   - **no report**: the last run ended as completed and no report followed;
   - **quota**: a quota cannot be read, or a paid balance is falling;
   - **no-fit**: no role resolves or no supply qualifies (fix the role mapping, requirements or worker capabilities);
   - **lingering**: a run's log ends with its report block and its process is still there (`dispatch.on_lingering`; stopped regardless after 2 minutes when the engine's own end event came last);
   - **looping**, **start-failed**, **lease-expired**, **monitor**, **commit-nudge** (document 014): a run going round in circles, a run with no start receipt and no commit, a lease held longer than its time, a monitor that could not be run, a run reminded twice to commit changed files;
   - **no-worker**: workers take it but every one is switched off, out of quota or at a limit (it waits; this is not a problem for a person);
4. Chooses what can be started. An order is a candidate if its stage is `queued` (so all `needs` are merged). Candidates are sorted with orders that continue after a monitor first, then reworked orders, then by table order. An order that needs a resource waits while the resource is full or exclusive-held (the reason is in `heldBack`); an order whose worker ran out and is set to `on_limit: rotate` is handed to the next worker at once, or waits when that worker is busy (document 014). A rework note, answer, monitor result or message stays on the order until a later run really follows it, so the next prompt still carries it. For each one:
   - the role resolves explicitly, by kind or through the default. Its required capabilities and avoid/only lists filter supply; explicit worker ids or aliases override those restrictions with capability warnings. Availability, launch, concurrency, daily-run and spend limits still apply. Rank is the role's ordered preference, then reviewed role × worker yield (at least three samples on both sides), included before paid, lighter load and file order (document 012). The choice and every rejection go to the run-start event and tick report;
   - the project's `caps` are checked for the order's kind and heavy class against the orders already running plus those chosen earlier in this tick; an order that was sent back for rework may use `rework_reserve` extra slots, so a new order can never push out one a person is pushing forward;
   - `min_free_ram_gb` is checked for orders the tool would start itself;
   - a card-only worker gives a **card** (a request to a person) instead of a start; an order whose last run ended badly gives a **resume** instead of a start.
5. Prints the result. A real tick (not a dry run) may also leave one commit reminder in the worktree inbox when a run has changed files and no commit for `dispatch.commit_nudge_minutes` (default 45; `0` turns it off). The next reminder waits another full period. The second one, while the tree is still dirty, is a `commit-nudge` problem and shows under Needs you.

## Output

Short, and the person's work first. A healthy thing takes no line.

```
alba tick (dry run)  11-03 19:57  exit 2

NEEDS YOU
  waiting for your answer or click: HO1B, RV1U

PROBLEMS
  W1: no commit for 2 h (limit 60 min).

WOULD DO
  start PF1B with coder-a
  offer a card to start CH1U in editor-session

HELD BACK
  X1: cap for "build" is full (5/5)

NOTES
  workers not available: coder-b (window "7 days" is 100% used, resets 11-06 09:53)
```

`--json` prints the same report for programs. Orders waiting for a person are listed but are not problems.

## Exit codes

For a scheduled check that only looks at the exit code:

| Code | Meaning |
|---|---|
| 0 | nothing to tell anyone |
| 1 | something can be done automatically: an order can be started, resumed or offered as a card |
| 2 | something a person should hear: a stalled or possibly finished run, a falling paid balance, an unreadable quota, ready work nobody can take (wins over 1) |
| 3 | the configuration is missing or wrong (project file, workers file, table mapping) or the command line is invalid |

## The board

[007](../console/007-board.md) shows the same report on a web page.

##  dispatch behavior

Answers and report repair messages use the normal tick planner, including project and worker caps. When a cap or worker slot blocks an answer, the order remains queued with a `waiting for a free slot` message; the next tick starts it as soon as capacity is available. A report bounce is treated as a same-worker resume and does not consume the automatic resume cap.

## Producer dispatch

`producer.round: { every_minutes: 60, enabled: true }` opts into a deterministic scheduled check in serve, independent of the automatic tick interval. Missing configuration leaves it off. A due round uses the same compact producer status and stall facts as the tick. It records a skeleton brief even when no attention is needed; a quiet round starts no model.

For each kind with eligible work, the round creates a `dispatch` proposal for the first move in the existing planner (monitor continuation, rework, priority, then queue row). Its card explains the choice and the next two alternatives. Planned work competing for that position opens a `ready-to-draft` case instead. The action defaults to `propose`; an explicit `dispatch` rule can select `auto`. Acceptance performs a fresh dry tick and rechecks kind/worker caps, memory, quota, resources, merged needs and the order body immediately before the existing launch path. A proposal reserves no slot. Changed facts refuse the action with the blocker and an event.
