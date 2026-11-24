# 044. Order phases

A project can give investigation and implementation to different workers on the same order and branch. For example, a reasoning model can inspect a cache bug and leave a plan for a faster coding model. Each phase uses an ordinary worker slot and contributes its own time, tokens and cost to the order.

## Configuration

In the project file, map each participating order kind to a phase list. The role names below refer to roles or routes configured in the project or workers file.

```yaml
phases:
  code:
    - id: inspect
      mode: read-only
      role: investigator
      timeout_minutes: 20
    - id: implement
      mode: write
      role: developer
```

Use one or more read-only phases followed by exactly one write phase. The first phase can also [split the order into children](045-split-and-integrate.md). Within each kind, ids must be unique and match `[a-z][a-z0-9-]*`. Omitting `role` uses the order's usual role resolution. A phase role uses its own worker preferences, capabilities, quota and concurrency checks. A positive `timeout_minutes` limits an individual run at dispatcher passes. A tighter worker time limit still applies.

`alba orders add CACHE --title "Check cache lookup" --kind code --phases none` opts out when creating an order. `alba orders set CACHE --phases none` opts out on an existing order. Kinds without a phase list use the ordinary dispatch flow.

## Planning and handoff

A fresh queue starts at the first phase. A read-only run inspects the order's worktree and returns its normal report block in its final message. Use a one-line `summary` and put Markdown in the `plan` field. A ready planning report requires a nonempty plan of at most 24 KiB in UTF-8. Alba records the plan on the report and writes a copy at `<state_dir>/runs/<TAG>-<run>.plan.md`.

| Planning worker | Enforcement |
|---|---|
| Codex CLI | The verifier launch uses the read-only sandbox, disables approvals, apps and plugins, and disables the configured MCP servers. |
| Claude CLI | The verifier launch permits Read, Glob and Grep and supplies an empty strict MCP configuration. |

Planning needs a launchable worker with a supported read-only adapter. Alba compares the worktree's HEAD, index, tracked changes and non-ignored untracked contents before and after the run. A changed worktree fails the run, including when the worker reported ready. A local run can inspect an existing dirty worktree in place. On an SSH worker the launcher checks the host worktree and returns the check result and final message. An unverified remote checkout cannot advance the order.

Once a read-only run ends successfully with a ready report, the order queues for the next phase. A waiting question, blocked report, failure or drop follows the usual handling for that status. Each subsequent phase receives the latest preceding plan from the current cycle, labeled with its authoring phase, worker and model. The implementer may depart from a plan when the code warrants it and explains the change in its report. A final ready delivery enters the ordinary review flow, including any configured first-pass or independent checks.

## Rework and retries

```sh
alba orders act CACHE rework --note "Cover the empty-cache case"
alba orders act CACHE rework --phase inspect --note "Recheck the cache lifetime"
```

The first command sends the order to its write phase with the existing plan. The second restarts planning at `inspect`. Earlier phases keep their plans. Plans at and after the restart point are replaced for the new attempt, and historical reports remain available on their runs. The console's rework dialog also lets the reviewer choose a phase.

A quota rotation or reroute continues the current phase and uses its role. A retry stays within that phase, and a phase boundary starts a new conversation. Each additional attempt consumes worker time and quota. Use the board for the current position, the order page for the phase history, and the run page for the plan a particular run received or produced. `alba orders show CACHE` lists the phases and `alba status` identifies the phase of a running order.

Order summaries expose `phase` with `id`, one-based `index`, and `count`. Order detail exposes `phases` in execution order. Each entry contains its state (`done`, `current`, or `next`) and run history, with worker and model when recorded. The current cycle's plan appears on its phase, and each historical report retains its own plan. Send `phase` with a `rework` request to `POST /api/orders/:tag/actions`. Use `phases: "none"` on order creation or the order fields endpoint for a per-order opt-out.
