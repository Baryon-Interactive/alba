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

With `dispatch.max_reworks` set (a whole number, no limit by default), a send-back past that many is refused unless `--override` is given: an order that went back that often needs a new approach, a split, a new order or a person, not one more round of the same. Automatic bounces (report repair, design change sets, evidence images) do not count.

For evidence failures, review and rework briefs follow this rule: Do not change file times or move files to pass this check; rerun the step or cite files from this run. Evidence carried over from an earlier run of the same order is a warning.

## `alba review <TAG> sheet [--out file.png] [--columns 4] [--cell 320] [--json]`

Puts the order's evidence pictures on one PNG and prints, per picture, its size, mean luminance (0 black, 1 white), spread and the share of near-black pixels, numbered in sheet order (left to right, top to bottom). The pictures are the ones the evidence list of the order page shows: named in its reports (newest first), then the evidence folders; at most 36. Only PNG is decoded; others are listed as skipped. The sheet goes to `<state_dir>/review/<TAG>-sheet.png` unless `--out` names a file. Cells are `--cell` pixels wide and as tall as the tallest picture needs. A black or near-empty capture (mean near 0, dark near 100%, spread near 0) shows at a glance.

A mean in range does not make a good picture: a grey, flat capture can meet a brightness target with no highlights at all. Each line also gives the share of highlights (`high`, luminance above 230 of 255), the 5th and 95th percentile of luminance (`p5`, `p95`; a narrow gap means a flat picture) and the mean HSV saturation (`sat`, 0 grey to 1 full colour). Luminance is Rec.709, from 0 to 1.

**Subject masks.** When `<name>.mask.png` lies next to `<name>.png` (same size; white where the subject is, black elsewhere), the line adds `subject <mean> vs <surround> (<difference>) <height>px`: the subject's mean luminance, the mean of the band around it (pixels outside the mask within a quarter of the subject's larger box side, at least 2 pixels), how much brighter the subject is, and the height of its bounding box in pixels of the picture. A mask of another size, or one that marks nothing, is reported as `mask skipped: <why>`. Masks are read with their picture and are not put on the sheet themselves. `--json` has the same values as `highlightFraction`, `p5`, `p95`, `meanSaturation`, `mask`, `maskSkipped`, `subjectMeanLuminance`, `surroundMeanLuminance`, `subjectContrast` and `subjectHeight`, next to the earlier fields.

**Evidence pictures are checked when the report arrives.** The images a `ready` report names (found in the worktree or the project root) are compared byte for byte, and PNGs are checked for a single flat colour. Copies of one file under different names (a worker described four copies of one capture as four camera moments), or a black or blank capture, send the delivery back to the worker once with the files named (event `evidence-bounced`); a second delivery with the same problem goes to review with an `accept-warning` event.

**Alba's own captures.** When a [capture recipe](037-capture-recipes.md) in `alba.yaml` matches the order (or a reviewer runs `alba capture <TAG>`), Alba builds and captures the delivered worktree itself under the capture lock, writes its own contact sheet (`sheet.png`) and `manifest.json`, runs the `identical`, `blank`, `dark`, `size`, `baseline`, `luminance` and `motion` gates on `<shot>.png`, and renders **Alba's captures** ahead of the worker's own pictures on the review card.

## Deterministic acceptance gates

`alba verify <TAG>` runs mechanical gates before a person approves an order. It checks the latest ready report's commits and evidence, the order's declared acceptance/evidence/path sections, protected gate files, the existing `alba check`, and merge readiness. It exits `0` only when no gate fails; `--json` returns the full result. Verification is recorded as an `order-verified` event, and a run ending with a ready report triggers that event once automatically.

An order can declare `## Acceptance`, `## Evidence`, and `## Paths` sections. Evidence bullets use `path: what`; path bullets use `allow:`, `deny:`, or `max-lines: <number> for <glob>`. A missing `## Acceptance` section and vague acceptance text are warnings; an order without `## Evidence` simply declares no required evidence. Headings may be numbered and carry a note: `## 4. Acceptance (the lead re-captures)` is the Acceptance section. Reported commits that are already on the base fail only when no new commit is left; next to new ones they are a warning. A project can protect gate definitions with `verify.protected_gates` in `alba.yaml`; changing one fails verification with `only a person can accept`.

Evidence newer than the current run's start is fresh. Evidence newer than the order's first run but older than the current run is carried over, giving `warn`; evidence predating the first run is stale and fails, as does missing evidence. Directories are judged by their recursive regular-file contents, reporting `n of m files fresh` and the carried-over count; an empty directory is missing. A required evidence glob passes with at least one fresh match, warns with carried-over matches and no fresh ones, and fails only with no usable matches. Reasons name fresh matches first and count leftover matches instead of listing old files.

Projects may add measured image rules under `verify.screenshots`:

```yaml
verify:
  screenshots:
    luminance:
      - { match: "**/*-cin*.png", mean_min: 0.22 }
      - { match: "**/*-cmd*.png", mean_min: 0.28, region: [20, 100, 1600, 700] }
    motion:
      - { a: "**/{name}-t0.png", b: "**/{name}-t1.png", region: [20, 560, 1600, 160], min: 0.5 }
```

Luminance uses Rec.709 weights and a whole image or pixel region; a region must fit inside the image and names its size when it does not. Motion compares paired frames on a 0 to 255 mean absolute luminance scale; different sizes fail. A rule matching no image is a warning, and an image that cannot be decoded is also a warning. The same measurements are available to scripts as `alba image lum <png> [--region x,y,w,h] [--json]` and `alba image motion <a.png> <b.png> [--region x,y,w,h] [--json]`. These gates measure; they do not replace a person opening the image.

An acceptance step can declare `artifacts: ["dist/Development/Windows/*.exe", "artifacts/package-receipt-*.json"]`. Passing steps record each matched file's relative path, size, SHA-256 and modified time in the `accept-step` event and `trial.json`; the `accept-trial` event and `alba orders show <TAG>` carry the same hashes. Missing globs warn unless `artifacts_required: true`; links whose real path leaves the trial or project root are recorded as `refused` and do not fail the step. Hashing is streamed and capped at 200 files and 2 GB, with `truncated: true` when a cap is reached.

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

## Closing an order the lead finished

```sh
alba orders close <TAG> --merged-elsewhere <commit-or-ref> [--note text]
alba orders close <TAG> --done-by-lead [--commit <sha>] --note "at least ten characters"
```

Marks an order `merged` (satisfying `needs` and clearing an earlier `cancel`) without running `accept_command` or writing `<TAG>.accept.md`. Allowed from `planned`, `draft`, `queued`, `waiting-needs`, `held`, `idle`, `awaiting-user`, `awaiting-review`, `blocked`, `failed`, `dropped` and `cancelled`; refused from `running` or `monitoring` (stop the run first) and from `merged`. The web console offers **Close** on `awaiting-review`, `awaiting-user`, `blocked`, `failed`, `dropped` and `idle`.

- `--merged-elsewhere <commit-or-ref>` resolves `<commit-or-ref>^{commit}` in the project repository, verifies with `git merge-base --is-ancestor` that it is on the order's base branch, records `action-merged-elsewhere` (`{ note, from, commit }` with the full SHA), and sets stage `merged` (`closed by the lead: merged elsewhere in <short sha>`).
- `--done-by-lead` requires a `--note` of at least 10 characters (an optional `--commit` is verified on the base branch the same way), records `action-done-by-lead` (`{ note, from, commit }`), and sets stage `merged` (`closed by the lead: done by hand`).

Use `approve --override` only when the worker's run itself delivered the work, because an override approval counts that run as accepted in worker routing history and role statistics. Use `orders close` when another commit on the base branch already landed the work or the lead finished it by hand: a completed run whose verdict is a close counts neither as accepted nor as reworked (a run that ended failed without a report still counts as `failed`).
