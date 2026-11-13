# 009. Checks, reference values, waiting and watching

Uses the terms of documents 001 to 008.

Before a person accepts an order, a few things are always looked at: is the worktree clean, did the executor touch what it must not touch, do the program's own check results still match the known good ones. `alba check` does that and records the finding as an event. The command never accepts, rejects or merges; automatic delivery lint can request rework under the producer policy described below.

## The `checks:` section of the project file

```yaml
checks:
  clean_worktree: true          # default true: no uncommitted changes in the order's worktree
  ahead_of_base: true           # default true: the branch has commits the base ref does not
  protected_paths: ["work-orders/**", "AGENTS.md"]   # must be unchanged against the base
  forbidden_tracked: ["artifacts/**", "**/*.dll", ".env"]   # must not be added or changed
  encoding_scan: true           # default true: added lines with "????" or U+FFFD (text that went through a code page), and JSON files the branch changed that start with a UTF-8 byte order mark
  max_new_file_kb: 512          # optional: no added file bigger than this
  references: checks/reference-values.yaml   # where the reference values live (relative to the project file)
  result_parser: '^(?<name>[A-Za-z][A-Za-z0-9_]*)(?=[: ])|"hash":\s*"(?<value>[0-9a-f]{16})"'
```

Paths are globs (`*` inside a folder, `**` across folders). The changes are those between the base ref and the branch (`git diff --name-status base...HEAD`). The worktree is the order's own, or the one found by its tag; the base ref is the project's `dispatch.base_ref`.

## Optional delivery lint

These keys add checks without changing the output of projects that omit them:

```yaml
checks:
  report_required: true
  revision_is_head: true
  base_merged: true                 # same as { max_behind: 0 }
  generated_paths: ["generated/**", "docs/build-output.md"]
  evidence_required: true
  report_must_match:
    - pattern: 'artifacts/{tag}/'
      message: 'Write the package into artifacts/{tag}/ and report that path.'
  report_must_not_match:
    - pattern: 'packages/shared/'
      message: 'Use packages/{tag_lower}/ for this order.'
```

| Key | Passing condition / repair |
|---|---|
| `report_required` | The final delivery has a valid final report block (or a valid standalone report JSON file). Inferred free-text/git deliveries fail. Write a complete final block to repair it. |
| `revision_is_head` | The report's `revision` resolves to the worktree's HEAD. A missing `revision` fails even when `commits` lists HEAD. Full hashes and unambiguous abbreviated hashes are supported. Report the current HEAD after committing repairs. |
| `base_merged` | At most `max_behind` commits of `dispatch.base_ref` are unreachable from HEAD. Merge the base and resolve conflicts to repair it. The mapping requires a nonnegative integer; `true` means zero and `false` disables the check. |
| `generated_paths` | No matching tracked file differs between the merge base with `dispatch.base_ref` and HEAD, including deletions. Restore generated paths from the merge base; do not commit build-regenerated data. |
| `evidence_required` | Every file path under the order's `## Evidence` exists in HEAD or the order's worktree; each glob needs at least one file. Create the missing evidence in this order's branch or worktree. |
| `report_must_match` / `report_must_not_match` | Each regular expression matches / does not match the structured report plus the original final message. Failures include the configured repair `message`. Expressions use multiline matching; `{tag}` and `{tag_lower}` expand literally in patterns and as text in messages. |

Every ready delivery from run completion, sync or manual report submission runs these checks synchronously and records the existing `check` event with `delivery: true`, its report sequence and a `lint` list. Repeated processing reuses that delivery's event. `alba check TAG` also prints these items. The order overview shows the latest delivery findings above its reports, preserving the result even after rework; the board marks orders that have received lint rework.

Only failures of the new delivery checks trigger `lint-bounce`; existing general/reference checks keep their previous behavior. Configure the producer rule in [020](../producer/021-producer.md). With the producer disabled, lint is still recorded for review, without rework actions. With no new keys, there are no added items or delivery events.

Delivery lint rework notes and producer review briefs include the evidence repair rule: Do not change file times or move files to pass this check; rerun the step or cite files from this run.

## Reference values

A *result file* is any text a program wrote: lines naming a check and giving values (hashes, counts). The tool does not know the format; the project gives it one regular expression, `result_parser`, with two named groups:

- `name`: a check's name. It sets the current name.
- `value`: a value. It belongs to the current name.

The expression is applied with `matchAll` to every line. A line with one name and one value gives `name`; a name with several values on the line gives `name#1`, `name#2`, … in order; a name with no value is **name only**: the check was named but gave nothing (for example it did not run). A value before any name on a line belongs to the previous line's name.

Reference values are a small YAML file: name → `{value, source, updated}`. `source` says why a person trusts it (for example "main after merge of X was accepted"). They only change through `alba refs adopt`, which a person runs after deciding that the change is expected.

### Comparing

`alba check <TAG> --results a.txt [--results b.txt] [--worktree dir]` (the worktree is the order's own, or found by a folder or branch name containing the tag, or given) parses the files in the order given. **A later file replaces an earlier one per name**: a rerun file overlays the first run. A name-only line never overrides an existing value. Every reference value then falls into one of four groups:

| status | meaning |
|---|---|
| same | the value equals the reference |
| different | a value was given and is not the reference |
| missing | the result files do not give a value (absent, or name only) |
| new | a value for a name the references do not know (listed, never a failure by itself) |

The report lists different, missing, new, then same, with the file each value came from.

### Exit codes

`0` all general checks passed and nothing is different or missing; `1` something failed, differs or is missing; `2` the configuration is wrong (no parser, parser without the named groups, unreadable file). The finding is recorded as a `check` event on the order (shown as "Last check" on the board's order page).

### Adopting

```
alba refs adopt --from run.txt --names po1,ar1 --source "accepted change X" [--tag T]
alba refs adopt --from main.txt --all --source "main at merge of X"      # first import
```

A name also takes its `#n` family and drops stale shape keys (three values became one). Names not found in the file stop the whole command and change nothing. It writes a `refs-adopt` event (on `--tag`, or `*`).

## `alba wait <TAG>`

Blocks, polling slowly (`--poll-minutes`, default 2), until the order's open run ends, stalls or the time runs out.

| exit | meaning |
|---|---|
| 0 | the run ended (a run the tool started is recorded exactly as a tick records it); one line says how |
| 2 | stalled: no commit or log growth for `--stall-minutes` (default `dispatch.stall_minutes`); the process is left alone |
| 3 | `--timeout-minutes` ran out |

An imported run (no process) is judged by `<TAG>.last.txt` and the git signal, as `alba sync` does, for this order only. If the last command in a Codex log is still running, the run is *waiting for a command*, which is said once and is not a stall until `dispatch.long_command_minutes` have passed.

## `alba tick --every <minutes>`

A real tick in the foreground, every n minutes. A round that changed nothing since the previous one prints one line; a round that changed something prints its whole report; a round ending in exit 2 or 3 is marked `!!! exit N … !!!` every time. It never exits on its own; Ctrl+C ends it. An error inside a round is a round with exit 3, not the end of the loop.

For a background job instead, [examples/schedule-windows.ps1](../../examples/schedule-windows.ps1) registers a Windows scheduled task running `alba tick` every n minutes (`-WhatIf` to look first, `-Unregister` to remove). The tool never installs it by itself.

## Acceptance-gate configuration

Deterministic gate definitions can be protected from worker edits in the project file:

```yaml
verify:
  protected_gates: ["alba.yaml", "work-orders/**"]
  screenshots:
    duplicate_diff: 0.015
    blank_std: 0.02
    dark_mean: 0.12
    dark_fraction: 0.85
```

If a branch changes one of these globs, `alba verify` fails and explains that only a person can accept the change.

The verification `evidence` gate uses both the ready report's run start and the order's earliest run start. Files made after the current run began pass; files made after the first run but before the current run warn as `carried over from an earlier run of this order`; files predating the first run fail as stale. Missing files fail. Directory timestamps do not decide freshness: recursive regular-file counts show fresh and carried-over files, and empty directories count as missing.

Each `required evidence` glob passes with any fresh match, warns when it has carried-over matches but no fresh match, and fails only when it has no matches or all matches are stale or empty. The reason names fresh matches first and counts leftovers. This freshness rule is separate from delivery lint's existence-only `evidence_required` check.

Screenshot formats are detected from their signatures. A mismatch between content and extension fails with the actual format and a save/rename instruction. Palette, grayscale, RGB and RGBA PNGs (plain or interlaced) are summarized, including 16-bit samples reduced to 8 bits; Huffman-coded JPEGs are summarized at one value per 8x8 block. GIF and WebP are listed as `not decoded (FORMAT)` and still checked for identical bytes.

`verify.screenshots` may be `off`, or a mapping overriding the four numbers shown above. Values are fractions from 0 to 1. `duplicate_diff` is the mean absolute difference allowed between 16×16 thumbnails, `blank_std` is the luminance standard deviation below which an image is blank, `dark_mean` is the mean-luminance warning threshold, and `dark_fraction` is the warning threshold for pixels darker than 0.05.
