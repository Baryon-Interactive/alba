# Design library

The design library records what each game system does, its formulas and parameters, measurable targets, and remaining gaps. SQLite is the source of truth. The decision ledger keeps decisions; links connect them to the current design. Gameplay values stay in the game's JSON files and are resolved whenever the library is read.

Design document intake is the library's entry point for a new project. Use [`030-design-intake.md`](030-design-intake.md) to configure a document set, create an intake order, review coverage, and accept each system's existing-format change set. Accepted worker proposals then use the same validation, versioning, history, and application path documented below.

## Enable

```yaml
state:
  backend: sqlite
design:
  enabled: true
  data_roots: ["content/**/*.json"]
  min_targets_per_system: 3
  export_dir: null
```

The section is optional; omitted or false returns instructions to enable it. File-backed projects must first run `alba state migrate` and select SQLite. `data_roots` defaults to an empty list, the target minimum defaults to three, and `export_dir` defaults to `<state_dir>/design-export`. An explicit export folder must be absolute. Data paths and globs must stay within the project; file references also check real paths. Symlinked directories are excluded from number discovery.

## Entities

Each entity has an integer `version`, starting at one, and an `updated` timestamp. Lists below default to empty unless stated otherwise. Optional metadata uses null.

| Kind and identity | Fields and constraints |
| --- | --- |
| `system`: `code` | Uppercase letter followed by uppercase letters/digits, 2–12 characters. `name`, `summary`, `status` (`not-started`, `prototype`, `playable`, `done`), document `source_refs`, `code_globs`, `data_globs`, paired `verified_commit`/`verified_at`. |
| `rule`: `<SYS>-R<nn>` | Two or more digits. `system`, `text`, nonempty `sources` of `{kind: decision\|doc, ref}`, `status` (`active`, `retired`), `superseded_by`, `implementation` (`none`, `partial`, `done`), `evidence`. Implemented rules require evidence; retired rules require a replacement rule or decision and cannot reactivate. |
| `formula`: `<SYS>-F<nn>` | `system`, `expression`, `variables` (parameter ids or named state fields), `number_kind` (`integer`, `fixed`, `float`), `rounding`, `timing`, `code_refs` (`file:line`), `notes`. Expressions are descriptive and are never evaluated. |
| `param`: `<SYS>.<group>.<name>` | Group/name contain lowercase letters and underscores. `system`, `location: {file, pointer}`, `meaning`, `unit`, `type`, nullable `range_min`/`range_max`, `source` (`baseline`, `decision`, `tuned`), `source_ref`, `rules`, `formulas`. Decision sources reference the ledger; baseline/tuned sources are explanatory text. |
| `target`: `<SYS>-T<nn>` | `system`, `metric`, nullable `min`/`max` (at least one bound), `unit`, `command`, nullable `last_value`, `measured_commit`, `measured_at`, `evidence`. A measured value requires commit, timestamp and evidence. Measurement commands are descriptions; reads and checks never execute them. |
| `gap`: `<SYS>-G<nn>` | `system`, `text`, `refs` (rules/targets/params), nullable `order`, `status` (`open`, `closed`), `closed_by`. Closed gaps require an existing decision or order. |
| `milestone`: `M-<NAME>` | Uppercase name, digits, underscores and hyphens. `name`, integer `position`, `status` (`not-started`, `active`, `done`), `criteria` of `{target}` or `{text}`. At most one milestone is active. |
| `term`: `term` | `meaning`, `avoid` (list of words), optional `system`. |
| `decision_link`: `<decision>:<kind>:<entity>` | `decision` from the existing ledger, entity `kind`, and `entity` id. Links cannot target another decision link. |

Evidence is a list of `{kind: order|file|report, ref}`. Report references use an order tag, optionally followed by `#<run-id>`. Document/file references can include `#anchor`; validation checks the file. Code references check that the line exists. Decision references first resolve exactly, then by their numeric ledger identity: leading zeros after the configured letter prefix are ignored, so `D007` and `D7` resolve in either direction. Stored references and history attribution use Alba's canonical prefix plus unpadded number. Ledger entries retain the original spelling in the additive `displayId` field when it differs; CLI and console displays use that spelling while links continue using canonical ids. This applies to change-set decisions, rule sources/replacements, parameter sources, gap closure and decision links. Unresolved ids still refuse the entire batch.

All entity, ledger, and order references must resolve, including forward references in the same change set. Systems cannot be reassigned on existing entities.

Parameter types are the fixed list `int`, `permille`, `milli`, `float`, `bool`, `string`. The first three require safe integers; fixed units use their integer representation. Floats must be finite. JSON Pointers follow RFC 6901 (`~1` for slash, `~0` for tilde; empty pointer selects the document). An unresolved pointer or wrong type refuses a change set; a value outside its configured range produces a warning. No value field is accepted in a parameter change or stored in its row/history. Resolved values appear separately in snapshots and exports, and on parameter reads.

## Validated change sets

```json
{
  "title": "Clarify income timing",
  "changes": [
    {
      "op": "update",
      "kind": "rule",
      "id": "ECON-R01",
      "base_version": 1,
      "fields": {"text": "Credit income exactly once per turn."}
    }
  ]
}
```

`title` and a nonempty `changes` array are required; `decision` and `order` are optional existing ids. `create` omits `base_version`; `update` and `retire` require the current version. Updates patch the supplied fields. Only rules retire; other entities use their statuses. Unknown fields, duplicate entities within a set, identity changes, and reused ids are refused. Retired rows remain present permanently.

Created and updated entities receive full field, live-file and reference validation against the combined prospective library before any writes, in one SQLite transaction. Unchanged entities are checked only for references affected by this batch, such as a reference to a rule being retired or a changed system. Stale locations and code lines on unchanged entities cannot block unrelated edits; use `design check` to find them. Automatic exports also return `param-unresolved` warnings for unresolved stored parameters. Retiring a referenced rule requires updating its referring entities in the same batch. A conflict names the entity, supplied version and current version, and writes nothing. Each applied entity change gets one immutable history row: `id`, `at`, `kind`, `entity`, `op`, `before`, `after`, `by` (`web`, `cli`, `accept`), `order`, `decision`, `changeset` (SHA-256 of canonical change content). Dry runs perform validation without changing rows, history or backups.

```text
alba design import-template
alba design apply changes.json --dry-run
alba design apply changes.json more-changes.json --order DEMO
alba design systems
alba design show ECON
alba design show ECON.income.base
alba design search income
alba design history ECON-R01
alba design export --out exports/design
alba design check --json
```

`design apply <file>... [--order TAG] [--dry-run]` reads and validates every file before one transaction writes any of them, including forward references across files. `--order` attributes every history row to that order. One input keeps the existing single-result output; multiple inputs return a result array. Reapplying identical file content is a no-op, including content applied through acceptance or earlier acceptance versions. Dry runs write no history, entities or exports.

Use the normal `--project` option to select a project. The template covers every entity kind; create its illustrative ledger decision, document and gameplay file first, or adapt the references. A system's `show` expands its rules, formulas, live params, targets, gaps, terms and linked ledger decisions. History without an id lists all changes.

## Structured target measurements

Targets optionally accept `measure` through the same validated change sets as other fields; omitted or null retains the existing manual workflow. The free-text `command` remains a human description. A structured example is:

```json
{
  "argv": ["node", "tools/measure.mjs"],
  "cwd": ".",
  "timeout_minutes": 5,
  "uses": ["test-rig"],
  "kind": "sim",
  "value": {"json_pointer": "/score"},
  "when": {"after_merge_paths": ["src/game/**"], "every_hours": 24}
}
```

`argv` is a nonempty argument vector, executed without a shell. Timeout and interval must be finite positive numbers. `cwd` is relative to the project and defaults to its root; real-path checks prevent escape. Optional `uses` references declared order resources and `kind` references a configured dispatch cap. `value` is exactly one of `{json_pointer, file?}` (JSON stdout, or a JSON file relative to cwd) and `{regex, group}` (stdout capture group, zero includes the whole match). The parsed value must be a finite number. File paths and merge globs remain inside the project. Unknown fields, malformed pointers/regexes and invalid resource or kind names refuse the change set.

Serve checks due targets every thirty seconds and after dispatch passes. A measurement is due initially, after its definition changes, after the configured interval, or after acceptance records merged paths matching `after_merge_paths`. Failed runs retry after an hour when no interval is configured. Without an interval, a successful measurement waits for a definition change or matching merge. Reads and checks never execute measurement commands.

```text
alba design measure
alba design measure ECON-T01 ECON-T02 --dry-run
alba design measure ECON-T01
```

Omitting ids selects due targets; explicit ids request a fresh run. Dry run reports runnable or waiting targets without executing commands, taking leases or changing history. Measurements wait for eligible orders, resource locks, kind capacity and the order free-memory threshold. Reservations use the same transaction and lease file as dispatch, so orders also see occupied measurement resources and cap slots. Without worker configuration, queued orders conservatively take priority. A measurement never preempts a running order.

Both streams are captured in `.alba/design/measurements/<target>-<run>.log`. Success applies a change set with `by: measure`, updating `last_value`, `measured_at`, `measured_commit` (base HEAD) and log evidence. A changed target version or HEAD during execution refuses the result. Command/timeout/parser failures append a `design-measurement` event with the reason and log path, preserving the previous value and evidence.

`GET /api/design/measurements` returns due/running state and the latest attempt; the export bundle adds this as `measurements`. Token-guarded `POST /api/design/measure` takes `{project, targets: ["ECON-T01"]}` and returns outcomes. Console target rows show saved measurement time and commit, current target state, due/running badges, latest success or failure reason, and **Measure now**. Target forms expose the structured definition as JSON in both languages.

SQLite schema version 6 widens the history actor constraint to include `measure`, copying existing history and recreating its index in a transaction. Entity payloads remain compatible; existing targets need no edits. Milestones add an optional `systems` list of existing system codes for goal discovery; target criteria also name their systems implicitly. See [goal drafting](../producer/021-producer.md#milestone-goal-drafting).

## Worker proposals and approval

At every run start the worktree receives `.alba/design/snapshot.json` with the entire library and worktree-resolved values, plus `.alba/design/README.md` with format instructions. `.alba/design/` is excluded locally from Git. It is an operational snapshot, and workers must not edit SQLite or treat the snapshot as writable state.

Workers write change sets to `.alba/design/changes/<name>.json` and list them in the final report:

```json
{"status":"ready","summary":"Income timing clarified","question":"","evidence":[],"commits":[],"design_changes":[".alba/design/changes/income.json"]}
```

Retain proposals in the worktree through approval. Both pipeline and manual approval apply the union of the latests's `design_changes` and `.alba/design/changes/*.json` files added or modified by the delivery branch relative to its merge base. Proposals merely inherited from that base are excluded from diff discovery, and deleted files are excluded. Diff proposals are read from the merged checkout; report-only operational files can still be read from the worker checkout. The design `accept-step` event adds `sources: {report: [...], diff: [...]}` beside its existing `files`. An `accept-warning` event records diff proposals when the latests lists none. Approval applies these files as one unit after the branch is merged, with `by: accept` and the approved order tag. Values and file references resolve against the merged project root. All files are read first, then validated against their combined next library, allowing references between files, before one transaction writes entities and history. Any malformed file, validation error or conflict leaves every pending file unapplied. An entity may appear only once across the pending files. Each file retains its own content hash, decision and order attribution. Retry recognizes already committed files, including recovery after an export failure, without duplicating history.

**Checked before review.** When a run reports `ready`, the change sets acceptance would apply (the report's list and those added or changed on the branch, intake sets excepted) are applied as a dry run against the library, with the worktree's files and nothing written. If the apply would refuse them (a wrong `base_version`, an id that exists or does not, a missing source or evidence, an unknown block, an `implementation` value outside `none|partial|done`), the delivery goes back to the worker once with the reason and the files (event `design-bounced`; the note resumes its session). A second delivery that is still refused goes to review with an `accept-warning` event, and approval refuses it as before unless overridden. Evidence under a path git ignores (an `artifacts/` folder) exists in the worktree but not after the merge, so the dry run cannot catch it.

A refused proposal records an `accept-step` failure with its reason and leaves the order awaiting review. The library changes, the merged record and the approve action are one transaction, so a pipeline merge is rolled back with them (and a pushed one is taken back from the remote). Fix the proposal and retry approval. A person can explicitly skip the refused proposals with `alba review <tag> approve --override --note "..."` (at least ten characters); a skipped step retains the reason and note. A handwritten acceptance note alone cannot bypass design approval. The same rule applies when design is disabled but a report still lists proposals.

## API and producer

All reads accept `?project=<id>`. `GET /api/design` supports `system`, `kind` and `query` filters. Equivalent read routes are `/api/design/systems`, `/show/<id>`, `/search?q=<text>`, `/history[/<id>]`, `/check`, `/export`, and `/import-template`. Export returns the bundle without writing files from a GET request.

`POST /api/design/changesets` takes `{project, changeset, dryRun}` under the existing write guard (the Origin check; with `--sign-in`, the console key in `x-alba-token` or a signed-in session). It returns applied/dry-run status, warnings, content hash and export location. Validation errors return 400, missing entities 404 and version conflicts 409. A post-commit export failure is reported as `export_error`; committed rows remain committed, so retry export rather than reapplying the change.

Producer calls use `producer_read` with `kind: "design"`, optional `filters: {system: "ECON", kind: "param"}`, and optional `query`. Top-level `system` and `design_kind` are also accepted. The response is `{available: true, value: ...}`; disabled design returns `available: false` and enablement guidance.

| Named query | Result |
| --- | --- |
| `open-gaps-without-order` | Open gaps with no assigned order. |
| `failing-targets` | Measured targets outside their inclusive bounds. |
| `unmeasured-targets` | Targets with null `last_value`. |
| `milestone` | The active milestone with each target criterion marked passing/failing/unmeasured; text criteria are manual. Null when none is active. |
| `stale-systems` | Systems with approved orders touching `code_globs` after `verified_at` (all such approvals when unverified). Includes order tags and `unknown_orders` where changed paths cannot be recovered. |

Approval retains changed paths from the pipeline trial, the integration merge's first parent, or a fast forward's preceding base reflog tip. Historical fast-forward merges without recorded paths or a surviving reflog are visibly unknown rather than silently reported fresh. Refresh a system's verification commit/time through a change set after reviewing it.

## Project console

The project navigation shows **Design** only when `GET /api/projects` (also the session's project list) reports `design: {enabled: true}`. This is an additive project metadata field; existing design routes and payloads are unchanged. Disabled projects report `enabled: false`.

The console routes are `/p/:project/design` (systems and search across every entity kind), `/design/:system` (rules, formulas, live parameters, targets, gaps, linked ledger decisions and history), `/design/milestones` and `/design/terms`, all beneath that project prefix. System filters cover status, failing targets and open gaps without an order; sorting covers code, name, status and the two problem counts. Rule bars count active rules only. Milestone text criteria remain manual and are never counted as passing automatically.

The readers use the existing `/api/design/export` bundle (including `resolved_values` and `history`), the `stale-systems` named query and the decision ledger. Reads refresh every 30 seconds. History is filtered by entity kind and identity and displayed newest first. Parameter CSV exports include live values and resolution failures; spreadsheet formula prefixes are escaped. File/pointer locations are editable metadata; gameplay values are read only in this console.

Each list has a New action and each entity has Edit; active rules also have Retire. Lists of strings use one item per line; structured sources/evidence, parameter locations and milestone criteria use labeled JSON fields with examples and field validation. Optional decision attribution is offered for rule and parameter changes. **Check change** posts a versioned change set with `dryRun: true`; validation and warnings appear below the fields. **Apply change** is enabled only for the checked fields and posts that same change set with `dryRun: false`, using the existing session write token. Editing a field invalidates the check. A 409 compares the proposed and current entities side by side; reload replaces the form with the current version before another check/save. A committed change with an export failure is reported as saved and cannot be reapplied from that form.

Synthetic demo data is available through `pnpm -C ui dev:mock`.

## Checks and exports

Checks also list root `.alba/design/changes/*.json` files whose content hash has never been applied, with an `unapplied-changeset` warning and a `design apply` hint. These warnings include proposals inherited from earlier work even though acceptance excludes those files from diff discovery.

Checks report unregistered numeric JSON leaves counted per file, missing/wrong-type/out-of-range params, stale formula code references, too few targets, systems without active rules, implemented rules without evidence, unassigned open gaps, and stale/unknown systems. Unresolved parameter files/pointers (`param-unresolved`) and missing formula files/lines (`code-ref-stale`) are warnings. Broken JSON in discovered data files, wrong types and missing implementation evidence are errors; coverage, ranges and staleness are warnings. `design check` exits one for errors and zero for warnings only. Boolean and string leaves are not unregistered numbers.

Every apply (including its automatic export), snapshot, check, read and explicit export owns a JSON cache keyed by real path. Each data file is parsed once per operation, including aliases and parse failures; a later operation rereads live files. Checks share the cache between numeric discovery and parameter resolution.

Every applied batch writes a complete snapshot directory beneath `export_dir`, retaining the newest thirty. Each table and history has a stable, sorted JSON file; `resolved_values.json` holds live values or resolution errors separately. Explicit export writes these files directly to the chosen folder. Exports are backups and diffable records; importing or hand-editing an export does not update the library. No model is invoked by any library operation.

Fixture evidence and acceptance commands are recorded in [the automated tests](../../test/design.test.ts).

Diff discovery, atomic multi-file application, content-hash idempotency and decision aliases are covered in [acceptance integrity validation](../../test/acceptance.test.ts).
