# Rejected concepts

| Idea | Why not |
|---|---|
| Setting an order's state by hand | It can contradict the facts. Only facts are stored; the stage is computed. |
| A company / role / hiring model for workers | Orders, runs and reports are enough. Workers are engines with limits. |
| Model judgement that bypasses policy or deterministic gates | Producer actions recheck the written rule, case revision, budget and acceptance evidence; taste remains a human decision. |
| Storing state without a backend boundary | SQLite and file stores share the order/event contract; project libraries and worktree files retain explicit ownership. |
| Guessing "is it waiting for me?" from prose | Workers report a status and at most one question. |
| Treating missing cost as zero | Usage windows, credits and optional currency budgets remain distinct; unpriced usage is explicitly unknown. |
| Polling quota inside every command | One read per tick, kept in a history file. |
| Running quota commands through a shell | A configured command is a program and arguments, so nothing in a file can inject shell syntax. |
| Counting a worker as available when its quota cannot be read | It may be silently spending credits; it is switched off until the quota can be read. |
| Requiring the console build for CLI operation | The CLI and server-rendered `/legacy` board work independently of the optional React console build. |
| A login for the board | It only listens on 127.0.0.1 and refuses other host names; anything more belongs to a deployment this tool does not have. |
| Waking a person for every healthy worker | Healthy things take no line of output. |
| Loosening an engine's permissions when it stops at a command | The command is named in a blocked report; adding an allow rule is a person's decision. |
| Writing the dispatch table back without a backup, or whole | A hand-kept table has text and columns the tool knows nothing about; only the mapped cells of changed rows are rewritten, after a backup. |
| Dispatching for a project that is only being followed | A shadow run records and compares; starting work is a separate decision. |
