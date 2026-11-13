# 008. Shadow run

Uses the terms of documents 001 to 007.

A shadow run lets the tool follow a project that people and other programs still run by hand: it sees what a careful reviewer would conclude, but it dispatches nothing and writes nothing into the project. The tool is given a project file whose `state_dir` is its own, and reads the project's table and work-order folder.

## What it takes

1. `alba table import` reads the hand-written table (the file is not changed). Rows that say "running" become orders with an open, imported run.
2. `alba sync` reads the work-order folder and records what the files show. A tag is the file name before `.last.txt` or `.accept.md`.
   - **`<TAG>.last.txt`**: the executor delivered. The tool records a run that ended at the file's modification time (outcome `completed`, imported: it does not count against daily limits and is never judged stalled) and a report. If the file ends with a report block, the report is that block. If it has no block (the file was written before the convention existed), the report is `ready` with the first line of the file as summary and is marked `inferred`; an invalid block is treated the same way and mentioned.
   - **`<TAG>.accept.md`**: the reviewer accepted it: an `approve`, so the order is `merged`. Only a ready delivery is approved this way (the order is awaiting review, no run is open, the note is newer than the report); a leftover note next to a failed, blocked or idle order is listed and left to a person, who approves with `--override` and a note.
   - Every fact carries the file's modification time. Running the command again records nothing new: a delivery counts as known when a report from the same file at or after its time exists.
   - Files from an earlier round are left alone and listed with the reason: the order is not in a stage where a delivery can be news (the table says it has not started, or waits for a person); the file is older than the order file or a prompt file that sent the order out again (`<TAG>-*.md`, `<TAG>-*.txt`); it is older than the last queue or rework done through this tool; an acceptance older than the delivery; a run started by this tool is still open (the tick records that end).
   - Files of tags that match no order are counted and listed.
   - `--dry-run` shows what would be recorded.
3. `alba tick --dry-run` then says what it would do and what it sees.

`alba prompt <TAG> [--out file]` helps while people still dispatch by hand: it prints the prompt file (pointer, pending rework note, report footer) so that a hand-started session also ends with a report block, and `sync` can read it with certainty next time.

`alba table render --write --file <copy>` (document 002) shows what the table would look like after the sync, on a copy, with the diff for a person to read.

## What it cannot see

- An order that was delivered in a place other than `<TAG>.last.txt` (the log of another program, a message in a chat) looks like it is still running. The `sessionClue` option of `syncOrders` is where a hint such as "the last message of the session that works on it was written at ..." would plug in; the command line does not use it yet.
- A reviewer's verdict other than "accepted" is not in the files, so a rework done outside the tool is seen only when a newer delivery appears.
- Time comes from file modification times; copying files resets them.

## Delivery read off git

Some work is done by sessions that leave no `<TAG>.last.txt`. With `sync: { git_signal: true }` in `alba.yaml` (off unless asked for), `alba sync` also looks at the git state of each running or idle order's worktree (the order's own `worktree`, or one whose folder or branch name contains the tag). It counts as a delivery only when **all** of these hold:

- the worktree has no uncommitted files;
- its branch is ahead of the base (the order's `base_ref`, else the project's);
- the last commit's subject matches `sync.git_subject` (a case-insensitive regular expression, default `\breport\b`);
- that commit is older than `dispatch.stall_minutes` (the worker is not just between two commits).

Then it records a run that ended at that commit's time and a report `ready`, `source: inferred-git`, whose summary is the subject and whose commits are the commits ahead of the base. The stage becomes `awaiting-review`. An order that a run started by this tool is working on is never judged this way (the tick records that end), and nothing is recorded twice for the same last commit. A worktree that fails a condition is listed with the reason (for example "the last commit does not say report"), so a person can see why nothing was recorded.

It is a signal, not proof: a commit that says "report" may be an interim report. The report says `inferred-git` so the reviewer knows.
