# 006. Review

Uses the terms of documents 001 to 005.

A run that ended with a `ready` report leaves the order in `awaiting-review`. A person (or a reviewing agent) looks at the branch and decides.

## `alba review <TAG> approve [--note text] [--branch b]`

With a project `accept:` section, approve uses the [acceptance pipeline](026-acceptance-pipeline.md): trial merge and ordered gates in a scratch worktree, evidence review, then a guarded merge, note and post-merge commands. The order page and producer share the review card and its **Accept and merge** action. Mechanical failures stay review cases; partial acceptance stays manual.

Without `accept:`, merging is **manual** (`dispatch.merge: manual`): the reviewer merges the branch into the base branch, then runs approve, which checks that this was done. Steps, in order; nothing is recorded if one fails:

1. the order must be `awaiting-review`, and no run of it may be open (a worker that is still going could change the branch under the approval);
2. the order's branch must exist and already be part of the base branch (`git merge-base --is-ancestor`). An order that came from a table has no branch recorded and approve says so; give it with `--branch b` (the console has a box for it beside Approve, and `POST /api/orders/:tag/actions` takes `branch`): the branch is recorded first (an `order-git-set` event, only when it exists) and then checked as above, so a branch that is not merged yet stays recorded and the plain approve works after the merge;
3. the project's optional `dispatch.accept_command` (program and arguments, `{tag}` and `{cwd}` allowed) is run in the order's worktree; a failing command stops approve and shows the last lines of its output;
4. `<TAG>.accept.md` is written in the work-order folder from `templates/accept.md` (order, run, report, commits, evidence, merge check, mechanical acceptance, and an empty place for the reviewer's conclusion). An existing file is never overwritten;
5. the design change sets (read from the merged branch) and the `approve` action are recorded in one transaction, and the order becomes `merged`, which makes orders that need it eligible. When they cannot be recorded, a note step 4 wrote is removed again, so no leftover note can approve the order later.

## `alba orders set <TAG> [--branch b] [--worktree p] [--base-ref local-branch]`

Records where an order's work is, for an order that never got it (imported from a table, or done in a session of a person's own). It prints what changed and writes an `order-git-set` event with the old and new values; the values are only checked for shape (a branch that does not exist is found out by the merge check). Do not edit the state files by hand.

## `alba review <TAG> rework --note text`

Sends the order back. The note is required: it goes into the prompt of the next run, under "Rework requested by the reviewer". The stage goes to `queued` (or `waiting-needs`), and the old report stops counting. A reworked order is sorted first by the tick and may use the reserved extra slot of a capped class (`dispatch.rework_reserve`), so new orders cannot push out one a person is pushing forward.

For evidence failures, review and rework briefs follow this rule: Do not change file times or move files to pass this check; rerun the step or cite files from this run. Evidence carried over from an earlier run of the same order is a warning.

## `alba review <TAG> sheet [--out file.png] [--columns 4] [--cell 320] [--json]`

Puts the order's evidence pictures on one PNG and prints, per picture, its size, mean luminance (0 black, 1 white), spread and the share of near-black pixels, numbered in sheet order (left to right, top to bottom). The pictures are the ones the evidence list of the order page shows: named in its reports (newest first), then the evidence folders; at most 36. Only PNG is decoded; others are listed as skipped. The sheet goes to `<state_dir>/review/<TAG>-sheet.png` unless `--out` names a file. Cells are `--cell` pixels wide and as tall as the tallest picture needs. A black or near-empty capture (mean near 0, dark near 100%, spread near 0) shows at a glance.

**Evidence pictures are checked when the report arrives.** The images a `ready` report names (found in the worktree or the project root) are compared byte for byte, and PNGs are checked for a single flat colour. Copies of one file under different names (a worker described four copies of one capture as four camera moments), or a black or blank capture, send the delivery back to the worker once with the files named (event `evidence-bounced`); a second delivery with the same problem goes to review with an `accept-warning` event.

## Deterministic acceptance gates

`alba verify <TAG>` runs mechanical gates before a person approves an order. It checks the latest ready report's commits and evidence, the order's declared acceptance/evidence/path sections, protected gate files, the existing `alba check`, and merge readiness. It exits `0` only when no gate fails; `--json` returns the full result. Verification is recorded as an `order-verified` event, and a run ending with a ready report triggers that event once automatically.

An order can declare `## Acceptance`, `## Evidence`, and `## Paths` sections. Evidence bullets use `path: what`; path bullets use `allow:`, `deny:`, or `max-lines: <number> for <glob>`. Missing sections and vague acceptance text are warnings. A project can protect gate definitions with `verify.protected_gates` in `alba.yaml`; changing one fails verification with `only a person can accept`.

Evidence newer than the current run's start is fresh. Evidence newer than the order's first run but older than the current run is carried over, giving `warn`; evidence predating the first run is stale and fails, as does missing evidence. Directories are judged by their recursive regular-file contents, reporting `n of m files fresh` and the carried-over count; an empty directory is missing. A required evidence glob passes with at least one fresh match, warns with carried-over matches and no fresh ones, and fails only with no usable matches. Reasons name fresh matches first and count leftover matches instead of listing old files.

The `screenshots` gate checks images named by the report or matched by the order's `## Evidence` globs, including `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp`. It detects PNG, JPEG, GIF and WebP from their bytes. An extension mismatch fails with a precise repair, such as `JPEG data in a .png file: save it as PNG or rename it .jpg`. PNGs (plain or interlaced) in RGB, RGBA, palette and grayscale (with or without alpha) are decoded without extra dependencies, including packed palette/grayscale samples and 16-bit samples reduced to 8 bits. Huffman-coded JPEGs (baseline, and the first scan of a progressive one) are read at one value per 8x8 block, from the blocks' DC coefficients: enough for the blank, dark and duplicate checks. Byte-identical images and PNGs whose 16×16 luminance thumbnails differ by less than 1.5% fail as duplicates; flat PNGs and JPEGs with luminance standard deviation below 0.02 fail as blank; a mean luminance below 0.12 or more than 85% of pixels below 0.05 warns as dark. GIF and WebP files (and arithmetic-coded or lossless JPEGs) receive the byte-identical check and are labelled `not decoded (GIF)` (or the detected format, or the reason); invalid PNGs include their decode reason. PNGs over 64 MB are skipped with a warning. Configure thresholds or turn the item off in the project file:

```yaml
verify:
  screenshots:
    duplicate_diff: 0.015
    blank_std: 0.02
    dark_mean: 0.12
    dark_fraction: 0.85
    # screenshots: off
```

## Override approvals

`alba review <TAG> approve --override --note "at least ten characters"` can approve a failed, blocked, or idle order after the reviewer records a note of at least ten characters. The action ledger records `override: true`. The web console shows a separate `Approve with override` action and requires the note in its confirmation form.
