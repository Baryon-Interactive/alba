---
name: alba-worker-rules
description: "How a worker started by Alba (alba) must work and report. Read it before you start and again before you stop: the report block, committing on time, waiting for long commands, the final message file."
tags: [alba, core]
---

# alba worker rules

You were started by `alba` to do one work order in a git worktree of its own. These rules are the same for every order.

## 1. Work in small, committed steps

- Work only inside this worktree, on the branch it is on. Do not push, do not change other worktrees, do not touch files outside the order's scope.
- Commit when a step works, not at the end: small commits with a clear subject. The tool watches the branch; an hour with no commit looks like a stall.
- Leave the working tree clean when you stop: everything done is committed, nothing half-edited is left behind.
- Put a new feature in new files, and keep edits to shared files (build lists, manifests, large scripts) small: other orders change them at the same time and merge after you.

## 2. Builds and long commands

- Waiting for one long command (a build, a test run, a package step) is allowed and is not a stall: the tool sees that a command of yours is still running and waits with you.
- Before your final message, wait for or stop every command you started in the background. One that ends after your final message makes you answer once more, and that answer, without the report block, becomes your last message.
- While such a command runs, do not edit files that are tracked by git: an edit made during a build can change what the build produced, and the result then proves nothing.
- Stop only processes you started yourself, by their process id: keep the id when you start the process (`Start-Process -PassThru`, `Popen.pid`, `$!`) and stop that id. Never stop processes by name (`Stop-Process -Name`, `Get-Process <name> | Stop-Process`, `taskkill /IM`, `pkill`, `killall`), and never stop a whole tree by parent id (`taskkill /T`). Other orders run the same programs on the same machine at the same time; stopping by name or tree ends their builds and games, and they fail with no error in their logs.
- Run commands one at a time and each as a command of its own. Some workers may only run commands that were allowed one by one; do not chain them with `&&` or `;` when they can be separate.

## 3. The final message and `<TAG>.last.txt`

When you stop, for any reason, write your final message, and if the order asks for a `<TAG>.last.txt` file, write the same text there. It must end with the report block below.

## 4. The report block

Opening a branch or writing a report is not the same as being done. End the final message with exactly this block, on lines of their own:

```
--- alba-report ---
{"status":"ready","summary":"one sentence","question":"","evidence":["path/to/proof"],"commits":["abc1234"]}
--- end ---
```

- `status` is one of:
  - `ready`: the work is done and committed, and you checked it against the order's acceptance criteria;
  - `waiting`: you need a person to answer one question before you can go on (put it in `question`). Use this when a decision is the person's to make: do not guess and carry on. The answer comes back to you, in the same conversation when your program allows it;
  - `blocked`: something outside your control stops you (put what is needed in `question`);
  - `failed`: you tried and it does not work, and you cannot see a way forward;
  - `dropped`: the order should not be done at all (say why in `summary`).
- `summary` is one sentence on one line.
- `question` is at most one concrete question, or an empty string. Never ask several questions, never ask for permission you already have. When the answer is a choice between a few things, add `"options"`: 2 to 4 entries, the one you recommend first, each a short text or `{"label":"...","note":"why","images":["path.png"]}`. When the choice is not about this order alone but about the project (candidate pictures for the look of something, a naming, a direction), add `"scope":"project"`: the question is then listed with the project's pick sets, where a person looks at the pictures large and chooses. When what you need is for a person to start a session and click a card, not to answer, add `"waiting_for":"card"`.
- `evidence` lists paths a reviewer can open to check your claim (test output, screenshots, a report document). `commits` lists the commits you made.
- Do not claim `ready` for anything you did not verify. Say what is not verified in your final message.
- Valid JSON on a single line between the two marker lines. Nothing after `--- end ---`.

## 5. Handing a long job to the monitor

A build, a package step or a batch on another machine can take an hour or more. Do not sit and wait for it with your session open: it holds one of the tool's worker slots and a window of your subscription for nothing. When the job is **already running on its own** (started with `Start-Process`, `nohup`, a scheduled or detached remote script: it must go on if you stop), and the next step really depends on its result, end this round with status `monitoring` and a `monitor`:

```
--- alba-report ---
{"status":"monitoring","summary":"package build started, about 80 min","evidence":[],"commits":["abc1234"],"monitor":{"check":["python","tools/build_status.py","--tag","ABC"],"cwd":".","done_when":{"file_exists":"artifacts/ABC/build.done"},"fail_when":{"output_matches":"BUILD FAILED"},"deadline_minutes":150,"note":"when it is done: read artifacts/ABC/summary.txt, then run the acceptance step"}}
--- end ---
```

- `check` is a program and its arguments (no shell). It must be **cheap and read-only**: it prints a status, looks at a log, a file or an exit code, and returns in seconds. It never starts, stops or changes anything. The tool runs it once every pass, in `cwd` (your worktree unless you say otherwise; only your worktree and the folders the project allows are accepted).
- `done_when` (and optionally `fail_when`) is exactly one of `{"exit_code": 0}`, `{"file_exists": "path"}` or `{"output_matches": "regular expression"}`. `deadline_minutes` is when you want to be called back whatever happens: about one and a half times what the job should take.
- Commit and leave the tree clean first. Then do nothing else: do not keep working on the job's inputs.
- When the job is over, failed, or the deadline passes, you are continued in the **same session**, first, ahead of new work. The first thing you read is the result and the end of the check's output, with your own `note`. Use the note to leave yourself the next step.
- Do not use `monitoring` for something a person must decide (that is `waiting`), or for a command that is quick (just wait for it), or for a job that dies when you stop.

## 6. A start receipt and a step list

Within a few minutes of starting write `<TAG>.progress.json` in the work-order folder (next to `<TAG>.last.txt`), and replace the whole file each time a step changes:

```
{"plan":[{"step":"read the order and the report of the last run","status":"done"},{"step":"change the menu code","status":"doing"},{"step":"build","status":"todo"}],"note":"one line on where you are"}
```

`status` is `done`, `doing` or `todo`. A run that has written no such file and made no commit for a quarter of an hour is taken to have failed to start (a wrong path, a sandbox or login problem), and a person is told at once; the board shows `step 3 of 7` from this file. Keep the steps few and honest (3 to 8); do not rewrite the plan to look busy.

## 7. Art: words first, then pictures

- A setting (a character, a place, a prop) has a text, a section of a Markdown file the setting card points to. **Make no picture, not even a test picture, before the text of the setting is confirmed.** It is confirmed when its card on the art page (or `alba art`) says so; a text that was edited after the confirmation is not confirmed any more. If it is not, improve the text if that is your order, end with a `waiting` report asking for the confirmation, and do not start on pictures.
- Pictures of a setting go under the folder `settings/<id>/` of the project's art folder and are listed in the `images` of its card. `refs` of a card are the **ids of reference cards**, never picture paths. A card still in the draft status has no pictures.
- Reference pictures go to the board with `alba refs add` (a page address, the tags, and what to take from it); never download pictures by hand into the project.
- Paid generation needs a quote file in the project's credits folder first, approved by a person with a cap; every paid call is a line in its spend file, with the wallet before and after. Never spend past the cap.

## 8. Skills

The skills you were given are listed in the prompt. They are shared and read-only for you: do not edit them. If one is wrong or missing something, say so in the report block with `"skill_suggestions":[{"path":"<skill>/SKILL.md","reason":"one sentence"}]`; a person decides.

## 9. Messages while working

- Read `.alba/inbox.md` after each commit, after each long command, and at least every 15 minutes. Each entry starts `## <id> <ISO time> <author>`; `reply <id>` refers to your question. After acting on an entry, append its id on its own line to `.alba/inbox-ack`. Older entries without ids still use `seen <ISO time>` under the message. A commit reminder permits a work-in-progress commit.
- Messages delivered mid-run framed as `[alba message id=<id> from=<author> at=<time>]` come from the same inbox and need the same acknowledgement (append the id to `.alba/inbox-ack` after acting on it, and use `reply` in `.alba/outbox.jsonl` when a reply is needed).
- Ask early: append one JSON line to `.alba/outbox.jsonl`, for example `{"at":"<ISO time>","kind":"question","text":"Which option?","options":["Recommended default","Alternative"]}`. Kinds are `question`, `blocker`, `note`, `eta`; `options` is optional. Use `question` only when you need a person's decision (it puts the order in front of them); progress goes in a `note`. Write UTF-8 without a byte order mark. Add `reply: "<inbox id>"` when answering an inbox message.
- Keep working on independent parts while an answer is pending. For a question with a sensible default, state that default and continue; do not end the run just to ask it. A decision that requires the person's answer must wait before dependent work starts.

## 10. Game windows and captures

- Several orders may run games on the same desktop. Capture only the window of the process you started (its window handle, e.g. `PrintWindow`, or the engine's own screenshot command); never a desktop region or a window found by its title, which picks up another order's game or records black for a DirectX 12 window. Use the project's capture script when its skill names one, or the scripts of the `game-capture-windows` skill when you have it.
- Run every capture under the machine's capture lock, so captures take turns: `node .alba/bin/lock.mjs capture -- <program> <arguments>` (it waits while another run holds it; keep the locked step short: start, capture, stop).
- Open every picture you name as evidence and say what it shows from looking at it, not from its file name. Two files with the same bytes are one picture.
- When the project defines a capture recipe for your order, Alba builds and captures the branch HEAD itself during acceptance, and the pictures you name in your report must still match what the branch renders.

## 11. Done means

- A test drives the code under test and asserts on its result. A test that cannot fail (only "no error", `status >= 400`, a constant against a constant, a call of `--help`) proves nothing; do not write one and do not count one.
- The feature is reached from the real entry point (the game, the tool, the page), not only from a test or a test switch. Search for a caller outside the tests.
- Never delete, loosen or skip an acceptance condition, assertion, check or threshold to make it pass. If it fails, it fails: say so in the report with what you measured.
- A claim about memory, speed or size comes from running the real program and measuring, with the command in the report.
- Evidence a check writes into the repository is not rewritten by running it again for your report: run `git status` after a check and keep only what you meant to change.
