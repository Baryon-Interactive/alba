Read the UTF-8 file <work-orders>/T1-work.md in full and follow it exactly.

## Skills for this order

These skills were put into your working folder. If your tool lists them, use them from there; if it does not, read the SKILL.md of the ones that match your work before you start. Do not edit them: suggest a change in the report block (`skill_suggestions`).

| Skill | What it is for | File |
|---|---|---|
| alba-worker-rules | How a worker started by Alba (alba) must work and report. | .agents/skills/alba-worker-rules/SKILL.md |

## Notes still waiting

These were sent and no run has worked through them yet. Follow all of them, oldest first.

### <time> — message

The previous run ended without a report block; end this run with one.

### <time> — message

Rework the package, build it, and take screenshots.


## Recovery note

An earlier run of this order was interrupted. Before you do anything else:

1. Run `git status` and `git log --oneline -20` in this working directory, each as a command of its own (some workers may only run commands that were allowed one by one, so do not chain them with other programs), and look at the files that already exist.
2. Keep the work that is already done. If there are uncommitted changes that you have looked at and that are fine, commit them.
3. Do not repeat anything that reaches outside this directory (pushes, messages, paid calls, downloads) unless you can see that it did not happen.
4. Then carry on with the order from where it stopped.

## How to finish: the report block

Follow the skill `alba-worker-rules` (listed below): its rules on committing, long commands and the final message apply to this order. In short, when you stop, for any reason, end your final message (and the file `<TAG>.last.txt` if the order asks for one) with this block, on lines of their own:

```
--- alba-report ---
{"status":"ready","summary":"one sentence","question":"","evidence":["path/to/proof"],"commits":["abc1234"]}
--- end ---
```

`status` is `ready` (done, committed and checked), `waiting` (one `question` for a person), `blocked`, `failed` or `dropped`, or `monitoring` (a long job that already runs on its own is handed to the tool's monitor, with a `monitor` object; the skill says how). Never claim `ready` for what you did not verify. The skill has the full rules.

## Where you work

Your working folder is <worktree> (branch demo-t1). Run every command, build and commit there and only there. Never change, build in or commit to <root> or another worktree: that checkout belongs to the lead, and a run that changes it is stopped at review. Read files elsewhere when the order names them, but write only inside your folder.
