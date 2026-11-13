# Local script demo

Requirements: Node 24 or newer, pnpm and git. No account, model, gateway or secret is required.

From the Alba checkout:

```sh
pnpm install --frozen-lockfile
node examples/demo/run.ts
```

The command prints the disposable project directory and accepted commit. It creates an order, queues it, dispatches the built-in `script` worker through a real tick into a new git worktree, reads its report, merges and approves the commit, and checks both the console's HTTP data and rendered order page on an operating-system-assigned port. The project remains available for inspection.

To inspect it interactively, use the printed directory as `<demo-directory>`:

```sh
node bin/alba.mjs --project <demo-directory>/project/alba.yaml serve --port 0 --every 0
```

For your own script worker, configure `engine: script` and a `launch` command. The script runs with the assigned worktree as its current directory. `ALBA_PROMPT_FILE` names the UTF-8 prompt and `ALBA_LAST_FILE` names the UTF-8 report destination. Write an `--- alba-report ---` JSON block ending with `--- end ---`. A successful process exit alone never constitutes delivery. `worker.mjs` demonstrates the full contract. Run `node --test test/demo.test.ts` for the automated integration check.
