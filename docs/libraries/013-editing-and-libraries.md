# 013. Editing the configuration, skills of the project, ledgers and lessons

Four things came together here: the workers file can be edited from the console without losing its comments, skills are split into those of the machine and those of the project (and filtered by engine), the decision ledger reads every table of a file, and the lessons library reads the multi-line format a studio usually grows.

## Editing the workers file

The console's Workers page has Edit and Copy on every worker and a New worker button; `alba workers set|copy|yaml` does the same from a terminal. Both go through one piece of code (`src/workers/edit.ts` on `src/yamledit.ts`):

1. The file is read as a YAML *document*, so comments and the order of keys and workers are part of what is edited. Only what changed is touched: a mapping such as `price` is compared key by key, a key that is not in the new value is removed, the rest stays as it was written. The line endings (CRLF) and a byte-order mark are kept, and a line the YAML writer would only re-space (the blanks before a trailing comment, the blanks inside `[ ]`) is given back as it was, so a diff shows what was edited and nothing else. One thing moves: a comment written on the same line as a key whose value is a mapping (`quota_sources:   # note`) is moved to the first line inside it.
2. The result is validated **as the whole file**, the way `alba serve` would load it (`validateWorkers`), and a `launch.env` value that looks like a key is refused (below). If anything is wrong nothing is written: the console shows the problem under the field it names (`details` of the 400), the terminal prints it and exits 1.
3. The old file is copied to `<file>.bak-YYYYMMDD-HHMMSS` (a second write in the same second adds `-2`), and only the newest 20 backups of that file are kept.
4. The new text is written to a temporary file next to it and renamed over the old one.
5. A `workers.edited` event goes into the project's event log (`worker`, `fields` as dotted names such as `price.per_mtok` or `launch.args`, the backup, and `by`: `web` or `cli`). The running `alba serve` reloads the file (it watches it anyway, and the API reloads at once so the next read already shows the change).

The API's field editor accepts supply fields: `notes`, `capabilities`, `model`, `model_family`, `cost`, `paid`, `pricing`, `price`, `route`, `quota`, `concurrency`, `daily_runs`, `daily_cap_usd`, `max_tokens_per_run`, `enabled`, `aliases`, `disabled_when`, `card_only`, `skills_mount`, `on_limit`, `rotate_paid`, `max_resumes` and `resume_backoff_minutes`. The usual fields appear in the console; other supply settings use its Advanced YAML editor. `launch` is edited as YAML. "Check" validates without writing (`dryRun`). Job kinds and preferences belong to roles. Worker fields `fits`, `kinds` and `profile` are rejected; use explicit role definitions and `notes` as described in [003](../workers/003-workers-and-quota.md).

```
alba workers set coder capabilities="[shell, edit, git]" concurrency=4 enabled=false
alba workers set coder aliases="[Coder, Cody]" daily_runs=null     # null removes a key
alba workers copy coder coder-fast concurrency=1 notes="Short usage window"
alba workers yaml coder
```

`alba workers set <id> <key>=<value>...` reads each value as YAML (`3`, `false`, `[a, b]`, `{ per_mtok: 3 }`, `null`) and a dotted key goes inside (`price.per_mtok`). `--dry-run` only checks. A copy goes right after the worker it was copied from; the id of a worker cannot be changed (add a copy under the new id).

### Safety

- The write calls are the same kind of call as every other write: with `--sign-in` the console key (`x-alba-token`) or a signed-in browser session, the origin check (only the server's own origin and `--allow-origin`) and the host check, and the server only listens on a loopback address. There is no call that writes anywhere but the workers file the server was started with (and the project file, for skills below).
- **Keys do not go into the file.** A `launch.env` value that looks like a key (`sk-...`, `ghp_...`, `xox...`, `AIza...`, `Bearer ...`, or a long random-looking mixed-case token), and the same shapes in `launch.args`, are refused with the field (`launch.env.NAME`) and a hint to use a command that reads the key from a file. A path or a `{placeholder}` is fine. The environment variable that holds a key stays where it was set (the shell, the provider's own login), never in `workers.yaml`.
- `GET /api/workers/:id/yaml` shows `launch.env` as written; that is why a key must never be there.

### Workers on one subscription, workers on one model

`quota:` names the source a worker is measured against. Workers with the same source draw on one subscription or balance: the Workers page groups them under the source ("same subscription quota"), the view lists them in `sharesQuotaWith`, and a quota exclusion names those peers. `model_family: example-family` marks equivalent models behind different tools (`sameModelAs`). A role's prefer/avoid/only lists can match that family as well as worker ids or aliases.

## Skills of the machine and of the project

The global sources stay where they were (`skills:` in the workers file or `skills.yaml`; they describe the machine). A project can add its own sources and say which engine it is and which global skills it does not want, in its project file:

```yaml
# alba.yaml
skills:
  engine: unreal              # unreal | unity | godot | any (ue, UE5, ... are accepted)
  sources:                    # the project's own folders; relative to this file
    - { id: house, dir: skills }
  include: [unity-ui]         # global skills to use whatever their engine: names or tags
  exclude: [writing, ui]      # global skills not to use here: names or tags. Wins over include
  always: [...]               # as before
  by_kind: { ... }
```

- A skill has **engines**: `engines: [unity]` (or `engine: unity`) in its front matter, `engines:` on its source, `skills: { name: { engines: [...] } }` in the registry, and the folders it sits in: below a source, a folder named `unity`, `unreal` (or `ue`) or `godot` tags every skill under it (a library that groups its skills by engine needs nothing else; use `layout: recursive`). A skill that declares nothing is for the engine its **name or tags** say: a whole word of the name (`unity-ui`, `godot-dev-guide`, `ue5-build`) or a tag (`unity`, `ue`) that is an engine. `engines: [any]` says it is for every engine whatever its name. A skill that names no engine at all is for every engine.
- What the project can use is: the tool's own skill, the skills of the project's own sources (always), and the global skills that pass: not excluded (by name or by one of its tags), and then either included, or not made for another engine than `skills.engine`. With no `skills.engine` nothing is left out by engine.
- A name in `skills.always`, `skills.by_kind` or named on an order that the project does not use is not attached and is reported (`... names the skill "x", which this project does not use (for unity, the project is unreal)`). Tags never pull an unusable skill in. What a worktree gets is only chosen from the usable skills.
- A project skill shadows a global one of the same name.
- `alba skills` lists the skills the project can use, then those it cannot with the reason (`--applicable`: only the first list). `GET /api/skills` gives every skill with `applicable`, `inapplicable`, `scope` (`global` or `project`), `engines`, `included` and `excluded`, and the sources with their scope.
- The Skills page has three columns: available in this project, global (not used here, with the reason), and the project's own. One click on **Do not use in this project** adds the skill to `skills.exclude`; **Use in this project** removes it from `skills.exclude` and, if its engine still keeps it out, adds it to `skills.include`. This is `POST /api/skills/use` `{ name, use }`; it edits the project file exactly as the workers edit above (comments kept, the whole file validated, backup, a `skills.edited` event, the file reloaded). A skill kept out by a *tag* rule in `exclude` is refused with the rule named, since a name cannot override a tag rule: change that rule in the file.

## The decision ledger reads the whole file

```yaml
decisions:
  file: ../notes/decisions.md
  section: "*"                 # or  all_tables: true:  every table of the file whose header has enough columns
  id_column: 1
  date_column: 2
  text_column: 3
  source_column: 4
  id_prefix: D
  reviewer_range: [2030, 2099]
```

With `section: "*"` each table is read and each entry gets the heading above its table as its `topic` (`DecisionEntry.topic`; `DecisionList.topics` lists them, and the console filters by section). A number that appears in more than one place keeps the **later** entry and is listed as a duplicate (`DecisionList.duplicates`, `alba decisions --check`, and a banner in the console). `alba decisions --topic "<heading>"` lists one section. The parsed file is kept until it changes (size and modification time), so the console can ask often; about 500 rows read in a few milliseconds.

## Project libraries

Lessons, picks, references, setting cards, credits and spend use the documented [English library schemas](../library-formats.md). There is one format, `alba`; no alternate layout is supported. Configure the paths in `alba.yaml`. All sections are optional.
