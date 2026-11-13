# 015. Art library: picks, references and settings, spend, outside usage

Four parts of a game's art work that are not orders: questions with pictures to choose from, a board of reference pictures with the written settings the art is made from, the quotes and spend files of paid generation, and the calls other tools make for the project. All of it is **optional**: a project file without the sections shows nothing and the pages say what to add. Nothing here changes the project's own files, except `alba refs add` (it appends a card to `refs.yaml`).

```yaml
# alba.yaml
picks:   { dir: Docs/picks,   format: alba, records: ../external-records/picks.jsonl }
art:     { dir: Docs/art,     format: alba, records: ../external-records/settings.jsonl, reuse_cache: ../external-records/cache/refs/demo }
credits: { dir: Docs/credits, format: alba, records: ../external-records/credits.jsonl }
usage_ledgers:                                   # also allowed in the workers file
  - id: gen
    file: ../tools/image-ledger.jsonl
    format: jsonl
    fields: { time: time, model: model, status: status, cwd: cwd, out: out }
    project_match: path
```

- `dir` is relative to the project's `root`; the paths written inside the files (pictures, the text of a setting) are relative to `root` too. `records` and `reuse_cache` are relative to the project file.
- `format` is `alba`, the layout of the files described below (the only one so far).
- `records` is the record of choices, confirmations and approvals that another tool already keeps, one JSON object per line. It is **read, never written**. alba keeps its own in the state folder (`_picks.jsonl`, `_settings.jsonl`, `_approvals.jsonl`; files starting with `_` are never read as orders), and every write is also an event (`pick-chosen`, `setting-approved`, `spend-approved`).
- `project_id` (in each section) is the project's name in those records when it is not the project's `id`.
- A record whose project is another one is left out; a line that cannot be read is listed (`recordProblems`), the rest is used.

## 1. Picks

A pick set is a question that belongs to the project, not to one order: candidates (each with pictures) to choose from.

```yaml
# Docs/picks/P1.yaml
id: P1
title: Door style
question: Which door should the first village use?
multi: false                 # true: several may be chosen
order: AR1                   # the order that raised it (optional)
decision: D12                # a decision exists (optional)
options:
  - { key: a, label: Round door, images: [Docs/picks/P1/a1.png, Docs/picks/P1/a2.png], note: warm }
  - { key: b, label: Square door, images: [Docs/picks/P1/b1.png] }
```

A worker can also ask one in its report: `"scope": "project"` next to `question` and `options` (the report needs both). Choosing it records the choice **and** answers the order that waits on it, through the usual answer path.

| State | Means |
|---|---|
| `pending` | nobody chose (or the choice is stale) |
| `chosen` | a choice counts, and no decision is written down; the console offers the decision text (`<title>: <labels>. picks:<id>`) to record in the ledger |
| `decided` | the file has a `decision`, or the decisions ledger (its file and its own entries) names `picks:<id>` |

- **Fingerprint**: the sha256 of the file's bytes (line endings of a checkout do not matter). A choice remembers the fingerprint it was made against; if the file changed since, the choice is **stale**: it is shown (`staleChoice`) but the set is `pending` again. `POST /api/picks/:id/choose` takes the fingerprint the page read, and refuses (409) when the file moved on.
- A missing picture, a key used twice, an option without a key are **problems of the file** (listed on the set); the set is still shown. A file that cannot be read at all (no id, no options, not YAML, an id used twice) is listed with its reason and does not stop the others.
- Choosing: one key (several for `multi`), a note of at most 4000 characters, who (a name typed in the console). A decided set can only be looked at; a choice made before the file got its `decision` line stays shown as history (no warning).
- Files whose name ends in `.spend.yaml` are not pick sets.

Command line: `alba picks [--json]`, `alba picks choose <id> --choice a[,b] [--note t] [--who n]`. Console: **Picks** (grouped, the pictures at their own size with pan, zoom, fit/actual-size, arrow keys, Space to select, a note and the confirmation in the large view) and the group **Waiting for a pick** on Needs you.

## 2. Art: references and settings

`<art dir>/refs.yaml` is a list of reference cards, `<art dir>/settings/<id>.yaml` the setting cards, `<art dir>/compare/` is only listed.

```yaml
# refs.yaml
- { id: ref-1, image: https://img.example.test/a.jpg, page: https://site.example.test/a, title: Harbor at dusk, work: Demo Work, tags: [harbor, dusk], learn: warm rim light, added: 2026-10-01 }
# settings/heroine.yaml
id: heroine
title: Heroine
kind: character
text: Docs/art/visual-setting.md#heroine     # a Markdown file and the anchor of a heading
refs: [ref-1]                                # ids of reference cards
images: []                                   # under <art dir>/settings/<id>/
status: text-draft                           # text-draft | text-approved | sheets | final
decision: D40
```

**The reference board.** Cards with a multi-tag filter (a card must carry all the tags chosen; the tags offered narrow with the selection) and a text search. A picture is shown once it is fetched.

- Fetching (`alba refs fetch`) keeps pictures in `<state_dir>/refs/` under the sha256 of their bytes, once, with an index by address. https only (no user name in the address), redirects are followed over https only, **one request per host every 1.5 s**, the answer must be an image, **at most 15 MB**, no human-check page (given up, never solved). What failed is in `failures.json` with the reason and shown on the board; the rest goes on. The exit code is 1 when some failed.
- With `art.reuse_cache` naming a folder another tool filled (`index.json` mapping ids to `{image, file}`), a picture found there is used **without a download** (read only; marked on the card). The index is looked up by card id and then by address.
- `alba refs add --page <url> [--image <url>] --title t --work w --tags a,b --learn "what to take from it"`: the picture is the page's `og:image` (or `twitter:image`) unless `--image` is given; the card is appended to `refs.yaml` with comments kept. `alba refs list [--tag t]`.
- Thumbnails are not made (no image library is a dependency); the browser scales the original.

**Setting cards.** The text of a setting is the **section of the Markdown file under its anchor**: from the heading to the next heading of the same or a higher level. The anchor of a heading is its text with the inline marks taken off, lower-cased, everything but letters, digits, `-` and `_` removed, spaces turned into `-`; a repeated anchor gets `-1`, `-2`, ... (`## Villain & Friends` is `villain-amp-friends`). The card shows the section, the cards it refers to, its pictures, the status and the confirmation.

- The status is shown as written. A word other than the four (`concept`, `draft`) is marked non-standard; `draft`, `concept`, `proposed`, `idea` mean "the text is still being written", like `text-draft`.
- **Validations are shown on the card, not thrown**: an anchor or file that is not there, pictures on a draft, a picture path in `refs` (it takes card ids), a picture that is missing or not under `settings/<id>/`, no `decision` past the draft, `sheets`/`final` without pictures, a status that says the text is approved with no confirmation on record, an id that is not the file's name.
- **Text confirmation**: `alba settings approve <id> [--note t]` or the button on the card records the sha256 of the section's raw text, who, when and why. If the section is edited afterwards the confirmation is **invalid** (shown: "the text changed after it was confirmed"); editing another section changes nothing. External confirmations (`art.records`) count the same way.
- **No picture, not even a test picture, is made before the text of a setting is confirmed.** The worker-rules skill says so (section 7, *Art*).

Console: **Art** (settings, reference board). `alba art [--json]`, `alba settings [list]`.

## 3. Spend

`<credits dir>/<id>.yaml` is a quote file; `<id>.spend.yaml` next to it is what was spent. The reader is tolerant, because real files drift:

- Quote: `quote_status` may be `exact`, `estimate`, `unknown`, `unknown_pricing_contract_expired` or any other word (shown, marked unknown); `items` is a list or a number; `total` may be `null`; the estimate is an `estimate:` block or `per_item` at the top (a number or a sentence); `cap_requested`, `notes`. An `exact` quote whose items do not add up to its total is flagged.
- Spend lines: `entries`, `spend`, `items`, `assets` or `steps` (a list, or the file itself is the list); a line has an amount (`credits`, also `cost`, `amount`, `credits_accounted`, `accounting_credits`, `credits_consumed`), and may have `at`, `asset`/`id`, `op`, `order`, `task`, `balance_before`, `balance_after`, `status`, `note`; YAML and JSON both read.
- A file with no list but its own total (`spent`, `total`, `total_accounted`, `spend_credits`, `accounting_credits`, `credits_consumed`) counts that total as the spend. Lines without an amount are listed (the first three, then a count).
- **Checks, flagged not thrown**: before - after = amount, one line's "after" is the next one's "before" (lines without both numbers are skipped; a wallet that other work also draws on differs on most lines, so the first three of each kind are listed and the rest counted), the file's own total equals the lines' sum (a total rounded to three decimals is accepted), the spend is within the approved cap.
- **Approval**: the sha256 of the quote file and a cap, who and when (`alba spend approve <id> --cap N`, or the console). A changed file makes the approval **stale** (needs a new one); external approvals (`credits.records`) are read the same way. Approvals made here live in alba's state, and the page shows them next to the quotes made on orders (`alba credits`, document 011).

Console: **Spend**. `alba spend [--json]`.

## 4. Outside usage

`usage_ledgers` (project file or workers file; the project's wins on the same id) name a JSON-lines file in which another tool records its calls. `fields` names the keys of a line: `time`, `model`, `status`, and `cwd` and/or `out`.

- A call belongs to the project when its `cwd` or `out` is **under the project's root** (or under the worktree of one of its orders). Case and slashes do not matter.
- `ok_values` (default `ok`, `succeeded`, `success`) are the statuses that count as success; everything else is a failed call.
- A time **without a zone is the machine's local time** (`timezone: utc` says otherwise); with a zone it is exact; a number is seconds or milliseconds. Days are local days.
- Only the configured keys are read; the text of a prompt in a line is never looked at or stored.
- `GET /api/usage?days=7`: per ledger the lines read, calls attributed, lines that could not be read; per local day and model the successes and failures, over the last `days` days (today included). The **Workers** page shows it as *Calls by other tools*; the order's page shows the calls made under its worktree.
- `alba usage [--days n]`.

## 5. Interface and files

| Call | Returns |
|---|---|
| `GET /api/picks?project=` | `PickList` |
| `POST /api/picks/:id/choose` | `PickChooseRequest` → `PickChooseResult` (409 when the file changed; 404 unknown set) |
| `GET /api/art?project=` | `ArtView` |
| `GET /api/art/ref/:id?project=` | the fetched picture of a card (404 until it is fetched) |
| `POST /api/art/settings/:id/approve` | `SettingApproveRequest` → `ArtSetting` |
| `GET /api/spend?project=` | `SpendView` |
| `POST /api/spend/:id/approve` | `SpendApproveRequest` → `SpendQuote` |
| `GET /api/usage?project=&days=` | `ExternalUsage` |
| `OrderDetail.externalCalls`, `Overview.pendingPicks`, `ProjectInfo.library`, `Report.scope` | calls under the order's worktree; sets waiting for a choice; which sections the project turned on; `project` for a pick set raised in a report |

Pictures of a set or a setting are read with `GET /api/files?project=&path=` (the usual rules for readable folders).

## 6. Limits

- `compare/` (screenshot comparison specs) is only listed; nothing is compared.
- A section of a Markdown file is cut by the algorithm above, not by a full Markdown parser: headings inside block quotes or lists are not top-level headings for the cut. A file where the two disagree shows a dead anchor on the card, never a wrong confirmation.
- Fetching is a command, not a background job; the console shows what is kept and why the rest is not.
