# Lessons: a deterministic simulation library (Alba pack `deterministic-sim`)

For games whose rules live in a library of their own, separate from the engine, run headless for many seeds. Tags: `sim`,
`engine`, `accept`, `content`.

## ALBA-SIM-01 Deterministic by construction
- tags: sim, engine
- rule:
  - No wall-clock time, no unseeded randomness, no iteration over unordered containers where the order changes a result.
  - Build with strict floating point (`/fp:precise /fp:contract-` on MSVC); do not assume two compilers give the same numbers.
  - When porting, keep the data structures, traversal order and random sequence; do not restructure while migrating.
- why: rules that do not repeat bit for bit cannot back a replay, a regression hash or a claim about outcomes.

## ALBA-SIM-02 The rules library has no engine and no network
- tags: sim, engine, build
- rule:
  - The library builds standalone with the project's script and also inside the game module; no engine headers, no downloads at build time.
  - The game client handles input, presentation, sound and UI and calls the library's interface; rules are never written in the client.
- why: it keeps the rules testable in seconds and lets headless tools run thousands of seeds.

## ALBA-SIM-03 A headless runner checks many seeds and the output hash
- tags: sim, accept
- rule:
  - Every rule change runs the headless tools over many seeds and compares the output hash with the last accepted one.
  - A change that alters a hash on purpose says so, with the reason, in the commit and the report.
- why: it kept the rules intact across engine changes and ports.

## ALBA-SIM-04 Scripted scenarios fix inputs, never outcomes
- tags: sim, content
- rule:
  - A scenario script contains orders and inputs only; every outcome comes from the rules.
  - No modifier applies only to one scenario or one run, and no per-scenario special-case resolution. Tuning changes shared rules or data, with the reason in the commit.
- why: an outcome written into the script proves nothing about the rules.
