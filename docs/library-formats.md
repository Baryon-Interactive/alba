# Project library formats

All libraries use one format, `alba`. The optional `format` setting accepts only that value. Paths in library documents are relative to the project root, must stay inside it, and use portable relative paths. Configuration `dir` values are relative to `root`; ledger paths are relative to `alba.yaml`. Unknown configuration keys are rejected. Unreadable or invalid documents are listed with problems instead of hiding the rest of the library.

```yaml
lessons: { dir: lessons, format: alba, kind_tags: {} }
picks: { dir: picks, format: alba }
art: { dir: art, format: alba }
credits: { dir: credits, format: alba }
```

## Lessons

Markdown files directly inside each configured lesson directory contain sections with an alphanumeric lesson ID and a nonempty `rule`. Fenced examples are ignored. English field names are case insensitive; tags are comma, semicolon or whitespace separated. `projects` is a comma-separated list of project IDs or names; absent or `*` means all projects. `level`, `why` and `check` are optional. Rules can span multiple indented lines. Order tags and kind select lessons; `kind_tags` adds project-defined tags and `all` selects every prompt. `max_rule_lines` is a positive integer, default 6.

`packs` adds Alba's built-in lesson packs (`templates/lessons/<pack>/`) after the project's folders; with packs, `dir` may be left out. Pack lessons have ids `ALBA-UE-nn`, `ALBA-WIN-nn`, `ALBA-ART-nn` and `ALBA-SIM-nn`, so they do not collide with a project's own, and use the tags below (map the project's kinds to them with `kind_tags`).

| Pack | Lessons | Tags |
|---|---|---|
| `unreal` | build through the project's scripts, one engine build at a time, rebuild prebuilt libraries, headless content scripts, `/Game` paths from Git Bash, SDK junctions, evidence from the package, instanced-mesh materials | `engine`, `build`, `package`, `accept`, `windows`, `art` |
| `windows-workers` | non-ASCII through PowerShell pipes, absolute paths and reading scripted edits back, no desktop automation, PowerShell 5.1, the proxy, tests never writing to the real profile | `all`, `windows`, `git` |
| `art-pipeline` | pictures only through the image tool inside the cap, returned sizes, paid 3D steps one at a time, choosing model settings, headless Blender scripts, judging pieces as the game shows them, provenance, the art bible before content, generation settings that match the shaders, range and subject contrast, consolidating passes, licences, key art against the game | `art`, `image`, `tripo`, `blender`, `engine` |
| `deterministic-sim` | determinism by construction, a rules library without engine or network, many seeds and output hashes, scenarios that fix inputs and not outcomes | `sim`, `engine`, `accept`, `content` |

```yaml
lessons: { dir: docs/lessons, packs: [unreal, windows-workers], kind_tags: { ue: [engine, build, package] } }
```

```markdown
## L-BUILD-01 Serialize builds
- tags: build, engine
- projects: *
- level: rule
- rule:
  - Acquire the configured build resource.
  - Release it after the build finishes.
- why: Parallel builds can contend for memory.
- check: Inspect the resource lease.
```

## Picks

One YAML document per question. `id` must contain letters, digits, underscores or hyphens and be unique. `options` is a nonempty list with unique nonempty `key` values. Each option has optional `label`, `note` and project-relative `images`. `multi` defaults to false. `decision` links an already decided set to the decision ledger. A choice must name known option keys; single-choice sets accept exactly one.

```yaml
id: layout
title: Workspace layout
question: Which layout should the console use?
multi: false
options:
  - { key: compact, label: Compact, images: [] }
  - { key: spacious, label: Spacious, images: [] }
```

## Art

`art/refs.yaml` contains a YAML list of reference cards. Reference IDs are unique. Image and page URLs must use HTTPS for downloads; local picture paths stay inside the project. Every reference records what should be learned from it. Missing images are reported. Downloading existing references is separate from generation.

```yaml
- id: bridge
  image: https://images.example.test/bridge.png
  page: https://example.test/bridge
  title: Stone bridge
  tags: [stone, bridge]
  learn: Study the wear along the edges.
```

Setting cards are `art/settings/<id>.yaml`. The filename must match `id`; `text` points to a Markdown document and optional heading anchor. `refs` names reference IDs, and images live under `art/settings/<id>/`. Status is `text-draft`, `text-approved`, `sheets` or `final`; draft synonyms are recognized. Confirmation records the SHA-256 of the exact text section. Editing the text invalidates its confirmation.

```yaml
id: bridge
title: Village bridge
kind: environment
text: art/settings.md#bridge
refs: [bridge]
images: []
status: text-draft
```

## Credits and spend

Quotes are `credits/<id>.yaml`; spend entries are `credits/<id>.spend.yaml`. Amounts are finite numbers; totals, approved caps and wallet arithmetic are checked. Unknown quote statuses remain visible and marked unknown. Spend metadata fields are `at`, `asset`, `op`, `order`, `task`, `status` and `note`; optional wallet fields are `balance_before` and `balance_after`. Approval uses the quote file's SHA-256; later edits require renewed approval. No approval executes a paid service.

```yaml
id: Q1
service: local-tool
order: ART1
created: 2026-11-01T00:00:00Z
quote_status: exact
items: 2
total: 10
cap_requested: 10
```

```yaml
entries:
  - { at: '2026-11-01T00:01:00Z', credits: 5, asset: first-item, balance_before: 20, balance_after: 15 }
spent: 5
```

The separate order-level credits API creates quotes with `service`, `unit`, `cap_requested` and optional `quantity`, `unit_price`, `total` and `note`. It records approval and append-only `{at, amount, what, by, key?}` spend entries; a spend with a `key` is booked once. Units are never combined. `credits gate` rejects unapproved quotes or expenditure beyond the remaining cap, and holds what it lets through (`holds: {key, amount, at, until, by}`) until the spend with that key or the hold lapses; `remaining` is the cap less spent and held.

## Records and caches

Optional external JSONL `records` files use English fields and are read only. Each row has ISO `at`, optional project ID in `project`, and `by`. Picks add `set`, `fingerprint` (SHA-256 of the YAML bytes) and a `choice` array. Confirmations add `setting` and `textSha256`. Quote approvals add `quote`, `fingerprint` and finite `cap`. Optional `note` is free text. `project_id` overrides the project filter. Local records use the same fields in Alba's state store and take part in chronological resolution. API provenance is `alba` or `external`.

An optional `art.reuse_cache` contains an `index.json` mapping image URLs to `{image, file}`. `file` is relative to that cache. Cache paths cannot escape the directory and must name existing files. There is no alternate project layout or conversion step.
