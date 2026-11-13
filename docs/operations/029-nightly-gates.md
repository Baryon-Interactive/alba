# Nightly regression gates

Orders can run their fast build, changed scenario and a few reference hashes. The factory runs the expensive suite once per nightly batch. Projects without `gates.nightly` keep their existing behavior.

```yaml
gates:
  window: "01:00-06:00"
  only_if_merged: true
  nightly:
    - name: reference-scenarios
      argv: [python, tools/regress.py, --json]
      cwd: .
      timeout_minutes: 180
      uses: [test-rig]
      kind: sim
      result:
        pass: { json_pointer: /passed }
        value: { json_pointer: /scenarios }
    - name: soak
      argv: [python, tools/soak.py]
      timeout_minutes: 4320
      uses: [test-rig]
      kind: sim
      result:
        pass: { regex: "SOAK PASSED" }
        value: { regex: "ticks=([0-9]+)", group: 1 }
resources:
  test-rig: { slots: 1 }
dispatch:
  caps: { sim: 2 }
```

Gate names are unique identifiers using letters, digits, dots, underscores and hyphens. `argv` is an executable and arguments, without a shell. `cwd` defaults to the scratch worktree root and must stay inside it, including after resolving symlinks. Timeout is a positive finite number of minutes, up to the process timer limit (about 24 days). `uses` and `kind` are optional and must name declared resources and a dispatch cap. No dependencies or worker slots are needed to launch a gate.

On Windows, `.cmd` and `.bat` scripts (including the npm/pnpm shims) need an explicit command interpreter, for example `argv: [cmd.exe, /d, /s, /c, "pnpm test"]`. A missing executable or invalid launch is a setup error. Scratch checkouts do **not** run `dispatch.provision`: gates must prepare their own dependencies in their command (or use preinstalled tools) and must not depend on provisioning done for an order's worktree.

Omitting `result` uses exit code zero as success. A configured reader must also pass, and nonzero exit always fails. `result.pass` is either a JSON Pointer into JSON stdout, or `{json_pointer, file}` into a JSON file relative to cwd; its value must equal boolean `true`, or the explicit scalar `equals`. Alternatively, `{regex}` must match stdout. Optional `result.value` reads a finite number with `{json_pointer, file?}` or `{regex, group}`; group zero selects the whole match. JSON result readers accept a UTF-8 BOM. Invalid JSON, unreadable result files and missing JSON pointers report infrastructure `error`; mismatched pass values, missing regex captures and nonnumeric values fail the gate. Both streams go to the log; readers consume stdout only (bounded at 8 MiB).

## Window and priority

Serve checks every thirty seconds and after a dispatch pass, even when the automatic tick interval is zero. The default window is `01:00-06:00` in the factory process's local timezone. The start is inclusive and the end exclusive. An overnight window such as `23:00-04:00` belongs to the date on which it starts. Equal start and end are invalid. A gate already started can continue past the window for multi-day soaks; subsequent gates wait until a scheduling window allows a new batch.

The default `only_if_merged: true` skips an unchanged base head since the last completed full run, whether that run passed or failed. On first use, there must be a recorded merged order or a merge commit in base history. Thereafter any base-head advance counts as a batch, covering fast-forward and manual merges as well as acceptance merges. Set false to run even an unchanged tree each night. A completed full batch runs at most once per local night. Resource waits retry in the same night at the originally pinned commit, without repeating gates already completed. A deferred batch that misses its window is replaced by the next night's full batch.

The base is the configured local `dispatch.base_ref` (default `refs/heads/main`), never the working checkout's current HEAD or dirty files. Commands execute in a detached scratch worktree at that commit under `<state_dir>/nightly-gates/worktree-<id>`. The checkout stays untouched. Worktree commands run asynchronously with a sixty-second timeout. The runner removes its scratch worktree on completion, failure, timeout or a resource wait between gates. Leftover cleanup falls back to forced directory removal and Git pruning; a locked leftover produces a notice and cannot abort a new batch. Commands must archive any artifacts they need to preserve outside the scratch folder before exiting.

Gates run sequentially. They yield to queued dispatchable orders before every launch, respect free memory, kind caps, exclusive resource rules and active order leases, including monitored orders. A gate waits while an order, acceptance trial or measurement holds any resource it needs, even with spare slots. While the gate holds a resource, new orders needing it wait. Reservation uses the same state transaction and lease file as dispatch and measurements; CLI and serve batches are also serialized with one batch lease. No running order is preempted.

CLI and serve use the same priority rule before each gate: queued orders with their dependencies met take priority when they need a resource or kind cap the gate needs. After an order has waited over two hours without starting, gates stop yielding to it and record a notice; active leases still protect running orders. Unrelated queued work does not delay gates. Priority callbacks used by tests run outside the state transaction. Nightly leases record the host and child OS creation times as well as PIDs; cached identities are refreshed after sixty seconds to detect PID reuse. Verified live holders keep their leases even past expiry. Leases are renewed during setup, execution and cleanup, and before the stop deadline. The batch lock budgets all gate timeouts, both worktree operations and stop grace, including multi-day soaks. On Windows, timeout stops verified processes by individual PID, checking creation times. Snapshots recorded at launch and during execution preserve descendant links after a parent exits. The runner releases leases only after confirming that the tree is gone; an unconfirmed tree retains resources and is retried with backoff.

```text
alba gates status
alba gates cancel
alba gates run
alba gates run --now
alba gates run --now --gate reference-scenarios
```

`run` respects the window and merge policy. `--now` requests a fresh batch immediately, bypassing time, nightly deduplication and merge eligibility; it still obeys resource, cap, memory and order priority constraints. Forced batches resume across serve passes, including outside the window, and are recorded separately: they neither consume a scheduled night nor advance its full-run/full-pass checkpoints. A forced batch waiting more than 24 hours is abandoned on the next pass, allowing scheduled nights to proceed; an executing gate keeps its configured timeout. `cancel` abandons unfinished batches when no batch or stopping tree holds the lock. The token-guarded API action is `POST /api/gates/cancel` with `{project}`; a running batch returns 409. `--gate` selects one named gate. A selected subset does not advance the full-run or full-pass checkpoint. A failed command or setup error exits the CLI with code one; waiting and skipped outcomes explain why nothing ran. `status` reads durable state without starting or reconciling commands. On the next scheduling pass, interrupted runs from an older night, changed configuration, changed selection or disabled gate list are marked `abandoned` with an end time.

## Results and failure attribution

Each gate records its commit, start/end timestamps, exit code, timeout flag, optional value, failure reason and log path in a `nightly-gate` event. Batch start/completion use `nightly-run-start` and `nightly-run`. Operational state and full logs retain the latest fourteen distinct nights; immutable event metadata remains in the project's ordinary event journal. Logs and a `run.json` summary live under `<state_dir>/nightly-gates/logs-<id>`.

A failure opens or updates one stable producer case per gate with trigger `nightly-gate-failed`. Its facts contain the failing gate and commit, the exclusive lower-bound commit from the last passing **full** batch (`from`, null before the first pass), and the merged order tags whose commits are ancestors of the failing commit but not ancestors of that lower bound. Acceptance and manual design-acceptance merge events provide exact merge commits; retained approved order branches also cover manually merged deliveries. Deleted branches without a merge record cannot be attributed. The range and tags identify candidates, not a claim that a particular order caused the failure.

Repeated failures update the same case; ordinary producer intake preserves it. A later passing result for that gate closes its case, including a selected rerun. A full passing batch advances the shared attribution baseline. The producer can propose an `add-order` remedy or discuss a revert for a person; the gate runner never merges or reverts automatically. The trigger is included in the default producer session triggers and can be selected in a project's session configuration.

Infrastructure failures (worktree creation failure/timeout, missing cwd, or executable spawn errors) have status `error`, appear in the overview and Activity with `nightly-notice` events, and never open or close regression cases or advance scheduled checkpoints. Gate timeouts and nonzero exits after a successful launch remain regression failures. Only a passing gate closes its existing case; a setup error preserves that case's original attribution.

The project overview's **Nightly gates** card shows the last batch, per-gate results and commits. Its Activity link opens the producer timeline, where batches contain child rows with individual results and log evidence. Displayed run timestamps follow the viewer's timezone; the scheduling window always follows the factory's timezone.
