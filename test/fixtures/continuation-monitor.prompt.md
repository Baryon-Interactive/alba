The long job you handed to the monitor is over (or its time ran out).
Use the monitor result to continue the order's remaining work, including its acceptance checks. A progress report alone does not finish the order.

The monitor says the job is over: the condition you gave for success was met.

Check command: fake-status (1 checks made)

End of the output of the last check:
```
package complete
```

Your own note when you handed it over: Read out/summary.txt, verify the package, and take screenshots.

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

This run holds slot 0 (`ALBA_SLOT=0`).
