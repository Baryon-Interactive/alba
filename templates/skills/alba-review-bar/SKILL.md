---
name: alba-review-bar
description: "For whoever accepts deliveries (the producer's review sessions, a lead, a person): the store bar a game delivery is judged against, and the ways a delivery passes its own checks without doing the work."
tags: [review, accept]
---

# Reviewing a delivery: the store bar

Judge every delivery as if this build went on sale today. "It works in the automated run" is not enough, and a delivery that
fails a line below is not accepted, whatever its own checks say. The report is a claim: check it against the branch, the
build and the pictures yourself, and keep "verified", "quoted from the report" and "not verified" apart in what you write.

## The bar

- **Nothing unfinished on screen.** No raw text keys (`MENU.TITLE`), no debug text or overlays, no "stand-in", "temporary" or
  "TODO" notices, no placeholder art where the real asset exists, no development-build watermark in captures meant for players.
- **No broken frames.** The camera is never inside terrain, under the ground, or pointed at sky or black. The screen never
  goes black during play. No light flicker: frame-to-frame mean luminance changes by no more than about 0.05 except on a
  deliberate cut (the `game-capture-windows` skill's `frames.mjs check` measures it).
- **Readable at the target resolutions.** Pieces and characters read at the game's camera distance; no text smaller than the
  subtitle size; no UI element overlaps another or runs off the screen, in every language the game ships.
- **Every visible feature works on the real path.** What a button, card or caption promises happens when a player does it,
  not only under a test switch or in an automated run.
- **Stable.** No crash, assert or hang on any screen. Switching away, resizing the window and quitting from every screen work.
  Settings and progress persist between runs.
- **First-time clarity.** A player who has never seen the game can tell what to do on each screen without a manual.
- **Clean rights.** Every asset (models, pictures, music, voice, fonts) has a recorded source and a licence that allows sale.

## How deliveries cheat (look for these)

- **One picture under several names.** Identical bytes, or the same screen captured twice and named as two different states.
  Compare hashes; open each picture.
- **Pictures that do not show what their names say.** `chinese-ui.png` in English, `night.png` at noon, five "different
  screens" that all show the start screen of an old package. Read every name as a claim and look.
- **Weakened acceptance.** An objective condition, assertion, check or threshold deleted or loosened so the tests pass (a
  medal tier that no longer requires the condition it was named for; a gate lowered to the measured value). Read the diff of
  tests, data and checks, not only the code.
- **Tests that cannot fail.** Asserting only "no error", `status >= 400`, constants against constants, a call of `--help`.
  A test drives the code under test and asserts on its result.
- **Features no real entry point calls.** The code and its test exist, but the game or tool never reaches it. Search for a
  non-test caller.
- **Rewritten evidence.** Running a delivered check can overwrite committed evidence with your own numbers: run `git status`
  after it and restore what changed.
- **Stale builds.** Captures or numbers from a package older than the last code commit, or from an editor instead of the
  package. Compare times; rebuild clean after a merge.
- **Estimates as measurements.** A memory, speed or size claim that lands exactly on the target; ask for the command that
  measured it, or measure.
- **"Network down", "tool unavailable".** Often the proxy or the worker's environment: repeat the failed step yourself
  before trusting the reason.

## Writing the finding

- Lead with whether it meets the bar, then each failing line with the file, picture or command that shows it.
- Say what you did not check, and why.
- Rework briefs name the exact defect and how it will be judged, not "improve the visuals".
