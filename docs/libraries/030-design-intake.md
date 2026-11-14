# Design document intake

Design document intake is the entry point for a new project's design library. It stores Markdown documents as file-backed or database-backed records, records content versions, and splits each version into stable blocks. A source reference has the form `doc-id@version#block-id`.

## Configure a document set

```yaml
design: { enabled: true, data_roots: [] }
design_docs:
  files:
    - { id: core-v1, path: design/core.md, order: 1, status: approved }
    - { id: content-draft, path: design/content.md, order: 2, status: draft }
  decisions:
    file: decisions.md
    all_tables: true
    id_column: 1
    text_column: 2
```

Later documents have higher precedence. Retired documents are retained for history and excluded from intake coverage. Database documents are imported with `alba design-docs import`; file-backed documents are updated by editing their Markdown and configuration entry.

## Foundations before content orders

A game project's first content orders need a few documents to exist first: an art bible, a palette, a scale sheet, lighting presets, an asset acceptance list. A project that starts content without them ends up with contradictory style rules and every batch judged against a different idea. The optional `foundations` section names, per kind of work, the documents that must be ready before its orders start:

```yaml
foundations:
  mode: warn                     # warn (default) or block
  art:                           # a set: any name
    kinds: [art, visual]         # orders of these kinds (after classification) ...
    tags: [scene]                # ... or with one of these tags
    docs: [art-bible, palette, design/scale.md]
  ui:
    tags: [hud]
    docs: [ui-kit]
    mode: block                  # a set may override the mode
```

A `docs` entry that names a `design_docs` id (a file entry above, or a database document) is ready when its status is `approved` and its file is not empty. An entry with a folder or an extension is a project file, ready when it exists and has text (it has no approval; list it under `design_docs` to require one). Anything else is missing.

While a set is not ready:

- `warn`: matching orders start as usual. Every tick reports one `foundations` problem per set naming what is missing and the queued or running orders going ahead without it; the console shows it under **Foundations not ready**.
- `block`: matching orders are held back (the tick's **HELD BACK** says why), and `alba run`, the console's **Run now** and the producer refuse to start them with the same reason.
- `alba orders add` (and a new order from the console or the producer) says what is missing, or that the order will wait.

An order tagged `foundation` (`--tags foundation`) is never held back: it is the order that writes the documents. Without a `foundations` section nothing is checked.

`alba foundations [--json]` lists each set, the state of each document and the orders it holds back or warns about; it exits 1 while a set is not ready. The art lessons `ALBA-ART-08` to `ALBA-ART-13` of the `art-pipeline` pack ([library formats](../library-formats.md#lessons)) say what an art bible holds.

## Commands and API

```text
alba design-docs list
alba design-docs show <id> [--version n]
alba design-docs import <md> [--id x]
alba design-docs export <id> --out <file>
alba design-docs set <id> --order n --status approved|draft|retired
alba foundations [--json]
alba intake [--docs id,id] [--tag TAG]
alba intake check [TAG] [--dir .alba] [--json]
alba intake review TAG --accept SYS,.. | --reject SYS --note text | --drop SYS --note text
```

The read API is `GET /api/design-docs` and `GET /api/design-docs/:id?version=n`. Database documents can be created or saved with `POST /api/design-docs` and `{project,id,title,body}`. Intake review data is available from `GET /api/intake/:tag/review`. System review uses `POST /api/intake/:tag/review` with `accept`, `reject`, `drop`, and a required `note` for reject/drop. Reject records one rework action naming only the returned systems; drop permanently excludes a system from the design library. Approval requires every system to be accepted or dropped. A later run resets returned systems to pending.

`alba intake check` reads `--dir` from the current folder (a worker runs it in its worktree); with a tag instead it reads the order's worker tree, and with neither the project's `.alba`.

An intake order uses `templates/intake.md` (or a project override). Its placeholders are `{tag}`, `{documents}`, `{snapshot}`, `{min_targets}`, `{alba_root}` (the absolute path of this alba installation, so the order can name the change-set format, this document, the coverage schema and the worked example in `examples/intake-demo/answers/alba/` without the worker searching for them) and `{alba_command}` (`node <alba_root>/bin/alba.mjs --project <project file>`, so the worker can run `intake check` from its worktree). Because `.alba/` is excluded from git in worker worktrees (the repository's `info/exclude`, which also covers everything under it), the order tells the worker to commit its outputs with `git add -f`; the review and the acceptance check read only what is committed. At run start the worker worktree receives `.alba/design/snapshot.json` and `.alba/intake/blocks.json`; the latter contains complete text and stable references for every block. The worker writes one existing-format change set per system, `.alba/intake/coverage.json`, and `.alba/intake/questions.md`. `coverage.json` follows [`schema/intake-coverage.schema.json`](../../schema/intake-coverage.schema.json). `alba intake check` runs every change set through `design apply --dry-run`, checks rule sources and target counts, and rejects missing or invalid block classifications. `superseded` references must point to a block in a later document. `unclear` entries name a gap that is also named by a list-item question. Intake orders run this check automatically as an `intake-check` acceptance step in the worker worktree.

The console exposes an Intake review link on intake orders. It presents document blocks in document order, the selected text and its review action, and bilingual status labels using the existing Dawn components.
