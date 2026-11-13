## How to finish: the report block

Follow the skill `alba-worker-rules` (listed below): its rules on committing, long commands and the final message apply to this order. In short, when you stop, for any reason, end your final message (and the file `<TAG>.last.txt` if the order asks for one) with this block, on lines of their own:

```
--- alba-report ---
{"status":"ready","summary":"one sentence","question":"","evidence":["path/to/proof"],"commits":["abc1234"]}
--- end ---
```

`status` is `ready` (done, committed and checked), `waiting` (one `question` for a person), `blocked`, `failed` or `dropped`, or `monitoring` (a long job that already runs on its own is handed to the tool's monitor, with a `monitor` object; the skill says how). Never claim `ready` for what you did not verify. The skill has the full rules.
