# 038. Visual targets, measured rounds and convergence

Uses the terms of [006. Review](006-review.md), [026. Acceptance pipeline](026-acceptance-pipeline.md) and [037. Capture recipes](037-capture-recipes.md).

Screenshot gates catch blank, dark or duplicate captures, and mean brightness alone can pass on a flat, desaturated scene. When an order declares a `## Target` section (including numbered headings with trailing notes such as `## 3. Target (noon sea)`), Alba compares its own captured shots from [capture recipes](037-capture-recipes.md) against reference pictures pinned on the trial's **base commit**, writes a three-panel side-by-side comparison sheet, tracks whether each metric moves closer or stalls across rounds, sends measured misses back automatically up to `verify.max_visual_rounds`, and stops once the round budget is spent with a **Not converging** record for the lead.

## Grammar (`## Target`)

```markdown
## Target
- shot: day
- reference: art/targets/sea-noon.png
- luminance: region 0,0,1,0.5 within 0.06
- luminance: region 0,0.5,1,0.5 between 0.30 and 0.45
- saturation: within 0.08
- histogram: max 0.25
- structure: cells 16x9 max 0.10
- motion: day -> day-later min 3
```

Rules of `parseTargetSection(markdown)` (`src/verify/target.ts`):

- Every `shot: <name>` line starts a target block (`[A-Za-z0-9_-]+`), naming a shot from the matched [capture recipe](037-capture-recipes.md). Lines after `shot:` belong to that block until the next `shot:`.
- `reference: <repo-path>` names a PNG read from the trial's **base commit** (`git show <base>:<path>`), never from the delivery worktree or working tree, so a worker cannot pass by replacing or adding its own target picture.
- A block without `reference:` may only declare absolute bounds (`between A and B`, `min A`, `max B`) and `motion:`. Using `within`, `histogram` or `structure` without a reference warns on the order and marks the block `unmeasured`.
- Optional `region x,y,w,h` gives fractional coordinates on `0..1` (`0 <= x, y < 1`, `w, h > 0`, `x + w <= 1`, `y + h <= 1`), converted to pixel rectangles independently on the capture and the reference so the two pictures may differ in resolution. Common halves (`0,0,1,0.5`, `0,0.5,1,0.5`, `0,0,0.5,1`, `0.5,0,0.5,1`) are labelled in plain words (`top half`, `bottom half`, `left half`, `right half`).
- `within T` compares the capture's value against the reference picture's value on the same region (`|measured - reference| <= T`). `between A and B`, `min A` and `max B` are absolute bounds.
- Any line inside `## Target` that is not understood emits an order warning (`Target line not understood: ...`, surfaced by `parseOrderSections` and `alba verify`) and marks that block `unmeasured`, never silently ignored.

## Metrics (`src/verify/target.ts`)

All metrics operate on decoded 8-bit PNGs (`DecodedPng`, alpha ignored):

| Metric | Range | Definition | Allowed bounds |
|---|---|---|---|
| `luminance` | `0..1` | Rec.709 `meanLuminance` (`0.2126 R + 0.7152 G + 0.0722 B`, scaled to `0..1`) over the whole image or pixel-converted fractional `region`. | `within T` (requires `reference`), `between A and B`, `min A`, `max B`, `min A max B` |
| `saturation` | `0..1` | Mean HSV saturation (`(max(R,G,B) - min(R,G,B)) / max(R,G,B)`, `0` when `max = 0`, matching `pictureStats`) over the whole image or `region`. | `within T` (requires `reference`), `between A and B`, `min A`, `max B`, `min A max B` |
| `histogram` | `0..1` | Normalised RGB histogram with 8 bins per channel (`8 x 8 x 8 = 512` bins, each summing to `1`); distance is `0.5 * sum_k |h_ref[k] - h_cap[k]|` (`0` identical colour distribution, `1` no shared bins). Independent of image size. | `max T` (requires `reference`) |
| `structure` | `0..1` | Mean Rec.709 luminance in each cell of a `cells CxR` grid (default `16x9`) on reference and capture; distance is the mean absolute per-cell difference across all `C * R` cells. | `cells CxR max T` or `max T` (requires `reference`) |
| `motion` | `0..255` | `meanAbsoluteLuminanceDifference` between two captured shots `<shotA> -> <shotB>` of the same dimensions (optionally restricted to `region`). | `min A`, `max B`, `min A max B`, `between A and B` |

## The `target` acceptance step (`src/verify/target-step.ts`)

When an order's Markdown file has a `## Target` section, `trialAcceptance` runs a step named `target` immediately after the `capture` step (provided no earlier configured step failed and the capture lock was not busy).

`AcceptStepResult.target` holds one `TargetResult` per block:

```json
{
  "shot": "day",
  "reference": "art/targets/sea-noon.png",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "rows": [
    {
      "metric": "luminance",
      "label": "top half mean luminance",
      "value": 0.482,
      "reference": 0.482,
      "bound": "within 0.06",
      "pass": true,
      "trend": "closer"
    }
  ],
  "pass": true,
  "sheet": "<state_dir>/acceptance/logs-<id>/target/day.png",
  "round": 2,
  "trend": "closer"
}
```

- **Unmeasured (`unmeasured?: string`).** Fails the `target` step (exit code `2`) and is **never** sent back automatically when: no capture recipe matched or no `capture` step ran, the named shot (or a `motion` shot) is missing or failed in `manifest.json`, the `reference` blob is absent on the trial's base commit, a PNG fails to decode (or `motion` shots differ in size), or a `## Target` line was not understood. `unmeasured` states the exact reason.
- **Side-by-side sheet (`sheet`).** Whenever both reference and capture decode, `targetSheet` (`src/review/sheet.ts`) writes `logs-<id>/target/<shot>.png` with three panels side by side: **reference** on the left, **capture** in the middle, and **per-cell luminance difference** on the right as grey levels (`0` black = identical cell luminance, `255` white = largest difference).
- **Rounds and trends.** `round` is `1` plus the number of earlier reports of the same order that recorded a `target` step result. From round 2 onward, each row compares its distance to the target/bound against the previous round's row:
  - `closer`: distance shrank by at least `10%` of the bound;
  - `farther`: distance grew by at least `10%` of the bound;
  - `flat`: distance changed by less than `10%` of the bound.
  Two `flat` rounds in a row (for example three deliveries whose measured values stay almost unchanged) mark the block `trend: "stalled"` (`stalled: true`).

## Automatic rounds and "not converging" (`src/verify/target-rounds.ts`)

Configure the automatic send-back budget under `verify:` in `alba.yaml`:

```yaml
verify:
  max_visual_rounds: 2   # whole number >= 0, default 2; 0 disables automatic visual send-backs
```

`applyTargetOutcome(project, orders, tag, trial)` runs at the end of `attemptAcceptance` (delivery lint, tick and producer intake) — **never** inside `mergeAcceptance` (approval) — and acts at most once per `trial.id` (later ticks reusing the cached trial do nothing again):

1. **Passed (`pass: true` on every block):** records `target-round` `{ trial, report, round, pass: true }`.
2. **Unmeasured (or an earlier step failed):** does nothing; the failed trial stays for review without automatic rework.
3. **Measured miss (`!pass`, not `unmeasured`, every earlier step passed):**
   - **Automatic send-back** when `reworkCount(doc) < verify.max_visual_rounds`, the order is not `held`, `reviewOf(project, doc.order)` is not `manual`, and `dispatch.max_reworks` allows it: calls `rework(orders, tag, note, { max: project.dispatch.max_reworks })` and records `target-bounced` `{ trial, report, round, action }`. These are ordinary reworks, so they count toward both `verify.max_visual_rounds` and `dispatch.max_reworks`.
   - The rework note gives each missed row's measured value, reference value and bound in plain words (for example `day: top half mean luminance 0.310, target 0.550 +/- 0.06: too dark`), the side-by-side sheet path, `automatic round N of M; after M a person decides`, and that Alba captured branch `HEAD` with recipe `<name>` so the worker's own pictures do not count for this check.
   - **Stop (`target-not-converging`)** once `reworkCount(doc) >= verify.max_visual_rounds` (or `max_visual_rounds: 0`, `order is held`, `review is manual`, or `max_reworks reached`): sends nothing back, records `target-not-converging` `{ trial, report, rounds, max, reason, history }`, and prepends `Not converging after N rounds:` (or `To the lead: review is manual` / `order is held` / `max_reworks reached`) plus the per-round history table to the `target` step's `tail` so the failed trial reaches the lead with the full trajectory.

## Events

| Event | When | Payload |
|---|---|---|
| `target-round` | Measured `target` step passed | `{ trial, report, round, pass: true }` |
| `target-bounced` | Measured miss sent back automatically | `{ trial, report, round, action }` |
| `target-not-converging` | Measured miss kept for the lead | `{ trial, report, rounds, max, reason, history }` |

## CLI and console

```sh
alba review <TAG> target [--json]
```

Prints the latest target table per block, any `Not converging` / `To the lead` notice, the side-by-side sheet paths and the one-line-per-round history (`report`, `revision`, per-metric values/verdicts, trends and `[stalled]` marks). Exit codes:

- `0`: every block passed;
- `1`: measured and at least one block missed;
- `2`: unmeasured (or no target measurement recorded yet).

In the console (`AcceptanceCard` -> `TargetPanel.tsx`), target results appear directly below the trial step list: missed rows are highlighted in red with per-row trends, the three-panel comparison sheet opens at 100% in the image viewer (`Lightbox`), and a **Not converging** alert banner displays the round history whenever recorded.

## Worked example: catching washed-out colours when luminance passes

Suppose order `T1` renders a noon sea scene on project `demo` against `art/targets/sea-noon.png` (vivid blue sky with sunlit clouds above rich teal water):

```markdown
## Target
- shot: day
- reference: art/targets/sea-noon.png
- luminance: within 0.06
- saturation: within 0.08
- histogram: max 0.25
- structure: cells 16x9 max 0.10
```

A worker delivers a desaturated fog pass that preserves per-pixel brightness while washing out chroma:

| Metric | Measured | Reference | Bound | Result | Why |
|---|---|---|---|---|---|
| `luminance` | `0.482` | `0.482` | `within 0.06` | `PASS` | Overall Rec.709 brightness is unchanged (`diff 0.0005`). |
| `structure` (`16x9`) | `0.001` | — | `max 0.10` | `PASS` | Per-cell grey contrast still matches the horizon and sun patch. |
| `saturation` | `0.158` | `0.812` | `within 0.08` | `MISS` | Mean HSV saturation collapsed by `0.654` (`too desaturated (washed out)`). |
| `histogram` | `1.000` | — | `max 0.25` | `MISS` | Pixels moved from sky/water RGB bins onto the neutral grey diagonal (`colours differ from reference`). |

Without `saturation` and `histogram`, a luminance-only gate passes the washed-out scene. With `## Target`, round 1 bounces automatically with the exact numbers (`day: mean saturation 0.158, target 0.812 +/- 0.08: too desaturated (washed out)` and `day: histogram 1.000, reference 0.000, bound max 0.25: colours differ from reference`) and the side-by-side sheet path.
