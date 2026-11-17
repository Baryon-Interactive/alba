# 026. Acceptance pipeline

An optional project `accept:` section automates the mechanical work between a ready delivery and approval. A reviewer still judges the evidence. Without this section, [manual merge and approve](006-review.md) behave as before, including `dispatch.accept_command`.

For expensive regression suites shared by merged deliveries, use [nightly gates](../operations/029-nightly-gates.md). This keeps per-order acceptance fast while the factory runs the full suite on a pinned base commit and attributes failures to the merged batch.

```yaml
accept:
  git_timeout_minutes: 2
  conflicts:
    take_base: [tools/build.py]
    take_branch: [config/feature.json]
    drop: [docs/generated/**]
  steps:
    - name: library
      command: [python, tools/build_library.py]
      timeout_minutes: 15
      when_changed: [library/**]
    - name: build
      command: [python, tools/build.py]
      timeout_minutes: 60
      resource: builder
    - name: tests
      command: [python, tools/test.py]
      timeout_minutes: 20
    - name: licences
      command: [python, tools/check_licences.py]
      timeout_minutes: 5
  note_template: templates/acceptance.md
  merge_message: "Merge {tag}: {title}"
  post_merge:
    - [python, tools/archive.py, "{tag}", "{merge_commit}"]
  parallel: 1
  push: false
resources:
  builder:
    slots: 1
```

Commands are executable/argument arrays, without a shell. Steps require a unique nonempty name and a positive `timeout_minutes`; nonzero exit, timeout, or a missing executable fails the trial and stops later steps. `when_changed` compares paths changed by the delivery since its merge base with the configured base branch; it skips the step if none matches. Omit it to always run. Globs use repository-relative paths with `/`, `*`, `?`, and `**`.

`git_timeout_minutes` is optional and defaults to 2. It must be a positive finite number (fractional minutes are allowed). It sets the timeout for each trial worktree creation, merge/conflict-resolution Git command, and cleanup command; the shared merge/conflict-resolution commands use it during real approval too. Large repositories or LFS checkouts may need a higher value, such as 10. It does not change `steps[].timeout_minutes` or the post-merge command timeout.

`resource` names either an existing resource or a dispatch cap. Applicable resources are reserved together before the trial, held through its steps, and released during cleanup. Full resources/caps leave a waiting trial for the next real tick or producer intake to retry. A declared resource takes precedence over a cap with the same name. Acceptance cap leases also count against tick dispatch. The default is one trial per project across processes; `parallel` can raise this limit. Real merges remain serialized.

## Trial and conflict rules

A ready delivery starts a trial after delivery lint passes. A real tick and producer intake also find eligible deliveries and retry waiting trials. The service creates a detached Git worktree under `state_dir/acceptance`, starting at the base commit, then merges the delivery commit with `--no-ff --no-commit`. The base checkout is untouched by the trial.

Conflict sides always refer to that merge direction:

- `take_base` keeps the base version, including a base deletion.
- `take_branch` keeps the delivery version, including a delivery deletion.
- `drop` removes a modify/delete conflict. It does not resolve content or add/add conflicts.

A conflicting path must match exactly one rule. Unknown paths and overlapping rules stop the trial with the unresolved file list. Rules only resolve actual conflicts; they do not discard ordinary nonconflicting changes.

Steps run in configured order. Each `accept-step` event records its name, passed/failed/skipped result, elapsed milliseconds, exit code, output tail and log path. An `accept-trial` event records the exact base/delivery commits, changed paths, conflicts, steps and overall result. Full command output and `trial.json` remain in `state_dir/acceptance/logs-<id>`; the generated scratch worktree is removed even after failure. Build artifacts inside it are temporary. Steps that need to archive outputs later must first place them in a project-managed persistent location.

**Capture step.** When a [capture recipe](037-capture-recipes.md) matches the order's effective kind or tags, `trialAcceptance` runs an additional step named `capture` after the configured steps pass, on the order's own worktree (whose `HEAD` must equal the trial's `branch`), writing `<shot>.png`, `<shot>.log`, `sheet.png` and `manifest.json` into `state_dir/acceptance/logs-<id>/capture/` under the configured machine lock. Orders matching a capture recipe without a project `accept:` section get an empty acceptance pipeline so the `capture` step still runs before approval. The matched recipe and screenshot gate settings join the trial fingerprint; a busy capture lock fails the step with `capture lock "<name>" busy` and marks the trial `retryable: true`. `AcceptStepResult.capture` and `AcceptanceCard.capture` carry the `CaptureSummary`.

After a worktree creation attempt, cleanup runs `git worktree remove -f -f` only for the generated `state_dir/acceptance/trial-*` scratch path, then attempts `git worktree prune` even if removal fails. Double force removes a checkout left locked as initializing by a failed or timed-out creation. If cleanup fails, the reason keeps the original failure first and appends cleanup errors for review.

Trials are cached by base commit, delivery commit, ready-report sequence and acceptance/check configuration. Changed inputs cause a new trial before approval. Waiting trials retry. A timed-out or killed trial Git command marks the failed trial `retryable: true`: its diagnostics remain recorded. Automatic delivery lint, ticks and producer intake retry unchanged inputs at most once every 30 minutes, using the persisted trial timestamp; calls during that interval reuse the trial without creating events or logs. Manual approval retries immediately. Changed inputs or an explicitly forced trial also bypass the interval. Other completed failures, including unknown conflicts and failed steps (also step timeouts), remain cached until inputs change or a caller explicitly forces a trial. A failing step or unknown conflict becomes a producer delivery case with its output and file list. Acceptance failures never automatically queue rework. Delivery lint retains its separate policy-controlled `lint-bounce` behavior.

**Visual target exception.** When an order declares a `## Target` section ([038. Visual targets](038-visual-targets.md)), `trialAcceptance` runs a `target` step right after `capture`. Measured target misses (where every earlier step passed and no block is `unmeasured`) are the one exception to the no-auto-rework rule: `attemptAcceptance` sends the order back automatically with `rework` while `reworkCount < verify.max_visual_rounds` (default `2`), provided the order is not `held`, `review` is not `manual`, and `dispatch.max_reworks` allows it (`target-bounced`). Once that round budget is reached (or blocked by `held`, `manual` or `max_reworks`), Alba records `target-not-converging` with the multi-round history and leaves the failed trial for the lead. `mergeAcceptance` never sends an order back.

## Shared review card

The order overview and Producer Analysis use the same acceptance card. It shows delivery lint, trial status and per-step duration/output, changed paths, and image evidence declared in the order's `## Evidence` section. Evidence globs expand in the delivery worktree. Thumbnails open in the existing full-size image viewer.

The same structured card reaches producer cases and `producer_read` with `kind: order`. Its `images` are absolute file paths so an image-capable session can open them with its allowed Read tool and compare them with the order's acceptance items. A changed trial fingerprint or status makes the delivery eligible for another session turn. An `accept` proposal links back to the order's review card.

## Accept and merge

Opt into a separate verifier before producer acceptance:

```yaml
accept:
  independent_check: { data: true, code: false }
roles:
  verifier:
    workers:
      prefer: [checker]
producer:
  budgets:
    review_runs_per_day: 8
```

`independent_check: true` enables every kind; omitted or false preserves existing behavior. An order overrides the kind setting with `orders add DEMO --check independent ...`, `orders act DEMO check-independent`, or `orders act DEMO check-none`. A person can request a fresh check with `alba orders check DEMO`; an already-running check is reused. Later ticks collect its final result.

The configured `verifier` role uses normal worker eligibility, quota, concurrency and daily-run limits, excluding the delivering worker by id or alias. If no different eligible worker exists, acceptance refuses. The launcher supports restricted Codex CLI and Claude CLI invocations; other engines cannot act as verifiers. Worker launch programs and named environments are retained, but ordinary mutation-capable argument templates and delivery sessions are not reused. Configure the model in `worker.model` or `worker.launch.model`. The verifier receives a detached checkout at the delivery commit, the order's `## Acceptance`, final delivery message, report and branch. It must inspect the requested sample rather than trust the delivery's claim. Builds and edits are forbidden; any checkout change fails the check.

Codex runs with its read-only sandbox and approvals disabled. Before launch, the service reads its effective MCP server configuration using the same executable, environment and checkout, then explicitly disables each server; failure to read that configuration fails the check. Claude receives a strict empty MCP configuration and only Read, Glob and Grep tools. Ordinary launch arguments, role-mounted tools and previous delivery sessions are not passed to either verifier.

The final JSON must contain nonempty `checked` items with `item`, `verdict` (`pass`, `fail`, `doubt`) and concrete `evidence`, plus a boolean `pass` and nonempty `summary`. Missing, malformed, or contradictory output fails closed. Producer acceptance remains pending while the verifier runs, and proceeds only with `pass: true` and all items passing. The merge boundary rechecks that the verdict still matches the delivery commit, report and acceptance text. Failed checks open a producer case containing the items and evidence; rework follows the normal policy rather than starting automatically.

Each auxiliary run reserves one `review_runs_per_day` slot before launch, including failed launches and explicit reruns. Repeated polling or acceptance attempts reuse the same result without spending another slot. The count resets at UTC midnight and appears in Activity. Independent runs do not replace delivery runs or reports. Their worker, run id, commit, verdict and evidence appear in the order's acceptance card and the associated accept activity row; its claim marker links to that check. A person's own `approve` bypasses the independent gate while retaining the normal mechanical acceptance checks.

Click **Accept and merge**, run `alba review <TAG> approve`, or execute a policy-approved producer `accept`. An `auto` accept rule runs the same service; `propose` requires the person's decision. Mechanical success does not judge screenshots. Partial acceptance remains manual: choose and merge the desired changes separately; the producer does not perform partial pipeline merges.

Set `review: manual` on an order with `orders add DEMO --review manual ...` or `orders act DEMO review-manual`. Producer accept and rework actions (including lint send-backs) become proposals regardless of the rule mode, and explain that a person reviews the order. Queued automatic actions also check the current flag before executing. A person can execute a proposal explicitly; changing back with `orders act DEMO review-auto` restores the project policy for future actions. The order page and `orders list` show the flag. An order without a review flag follows the project's top-level `review: manual | auto` in `alba.yaml` (default `auto`), read when the decision is made, so setting `review: manual` there makes every order that does not say otherwise manual, including existing ones. `--review auto` on an order overrides a manual project default.

A branch that a person has already merged into the base (by hand, with their own conflict fixes or as part of a batch) is approved on the manual path instead: no trial, no pipeline merge, no post-merge commands, and an existing acceptance note is kept. A branch that is in the base only because it never moved (a ready delivery with no commits of its own; the branch's reflog shows where it was created) has nothing merged by hand: its trial still has to pass before approval.

Approval requires a clean base checkout, including untracked files, on its configured local base branch. A dirty or wrong-branch checkout is refused without changing it. Stale trial inputs trigger a fresh trial; after it passes, the service rechecks the base HEAD and delivery inputs before touching Git. A concurrent change refuses approval for a retry.

The real merge uses the same conflict rules, creates a merge commit with `merge_message` (default `Merge {tag}: {title}`), writes `<TAG>.accept.md` in `work_orders`, runs `post_merge` commands in the base checkout, pushes when `push` is on, then approves the order. An existing note is never overwritten. Post-merge commands run in order with a sixty-minute timeout each, with separate output logs and events. `push` defaults to false and no Git push is attempted unless explicitly enabled in project configuration; it pushes the merge to the base branch's upstream (else `origin`).

Approval is refused while a run of the order is open. A merge either completes or is rolled back to a recorded state. Before its first change it writes `<state_dir>/acceptance/merge-journal.json` (the base branch's tip, then the merge commit, the note and what the push changed on the remote) and records `accept-merge-started`. The design change sets (committed ones read from the merge commit, others exactly as the trial saw them), the `accept-merged` record and the approve action are one state transaction at the end. Any failure undoes the steps in the journal: the remote branch is put back with `--force-with-lease` (only while it still has the merge), the note is removed and the base branch is reset to its old tip (changed files are kept in a stash). A process that died midway leaves the journal, and the next approval rolls it back first (`accept-merge-recovered`). Post-merge commands cannot be undone: keep them safe to run again. An approval refused because the trial is only waiting (delivery lint not passed yet, another trial holds the project slot) is recorded as `accept-merge-waiting`, once per reason, not as `accept-merge-failed`: a caller that retries approval in a loop does not bury the real failures.

With `accept:` configured, sync does not infer approval from an acceptance-note file: the pipeline owns the final approval after post-merge commands succeed. `orders act DEMO approve --override --note "Source and evidence independently checked"` also accepts a `failed` delivery or an `awaiting-user` delivery with a report. The override note must have at least ten trimmed characters. These deliveries follow the same trial merge, passing mechanical gates, post-merge commands, design application, events and acceptance-note path as ready deliveries. Without the override they remain ineligible. The producer never requests an override.

`note_template` is relative to the project configuration file. If omitted, a built-in Markdown note is used. The note, merge message and post-merge arguments support `{tag}`, `{title}`, `{merge_commit}`, `{step_results}`, `{findings}` and `{reviewer}`. The merge commit placeholder is available after committing, in notes and post-merge arguments. `<TAG>` and `<title>` are accepted aliases. Findings come from the approval note; reviewer is the acting reviewer, including `producer` for producer decisions.

```markdown
# Accepted: {tag} — {title}

Merge: {merge_commit}
Reviewer: {reviewer}

{step_results}

{findings}
```

Failures abort an unfinished merge. If a post-merge command fails, the service removes its note and restores the original branch tip with `git reset --merge`, preserving command changes or concurrent edits in a named Git stash first. It never uses a hard reset. Failure and any recovery stash are recorded, and the order stays awaiting review. External effects of project commands, such as an archive upload, cannot be undone by Git; make those commands safe to retry. A rollback failure is reported explicitly for manual recovery.

See [the temporary-repository validation](../../test/acceptance.test.ts) for the known/generated conflict, accepted card, note/post-command and unknown-conflict demonstrations.

See [acceptance integrity validation](../../test/acceptance.test.ts) for failed-delivery overrides, per-order manual review and design proposal recovery.

See [independent check validation](../../test/independent-check.test.ts) for verifier gates, queued messages, cleanup sizes, held runs, idle sessions and browser evidence.
