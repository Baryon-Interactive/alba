# Routing and skills

Two things the tool decides before a run starts: which worker takes an order, and which skills that worker finds in the worktree.

## Compute supply and jobs

Workers describe compute supply: engine, model, route, quota, cost, limits and capabilities. Roles describe jobs: kinds, required capabilities, skills, MCP servers, rules and ordered worker preferences. Worker `notes` never affect routing. See [003](003-workers-and-quota.md) for the capability vocabulary and migration from worker-owned job fields.

```yaml
workers:
  - id: primary
    engine: codex-cli
    capabilities: [shell, edit, git, long-run]
    notes: Weekly usage window
    cost: included
roles:
  builder:
    kinds: [build, merge]
    requires: [shell, edit, git]
    workers: { prefer: [primary, backup], avoid: [card-worker] }
  default:
    requires: [shell]
```

## Kinds

An order has one main kind and any number of extra tags. The project names the kinds it uses in `alba.yaml`:

```yaml
kinds:
  build:  { description: "Builds and packages", match: '\bbuild\b|\bpackage\b' }
  web:    { description: "Web pages and TypeScript", match: '\.tsx?\b|\bvite\b' }
  visual: { description: "Needs looking at pictures", match: 'screenshot', tag_only: true }   # only ever an extra tag
classifier:
  worker: light-worker       # asked when the rules decide nothing (optional)
  max_chars: 4000            # how much of the work-order text it is shown
  timeout_seconds: 180       # how long it has to answer
  max_per_pass: 10           # at most this many questions per import or pass
  parallel: 1                # how many at once (some engines keep their state in one database that two runs at once lock)
```

Kinds are tried in the order written; the first one that matches (and is not `tag_only`) is the main kind, every other match is a tag. `match` is a regular expression (or a list of them) tried against the order's title and the first `max_chars` of its work-order file; `ignore_case: true` makes it case-insensitive, `title_only: true` makes the rule look at the title alone (a long work-order text mentions many things in passing; a title that carries a marker such as "(UE)" is a better sign). The `dispatch_table.kind_rules` read the kind off the words of a table row and may also add `tags`.

How an order is classified (`Order.routing`; the rules are read again every time, a model's answer is kept until the work-order text changes):

1. a kind the table row or a person gave: `source: table` or `manual`;
2. otherwise the project's `kinds` rules: `source: rules`;
3. otherwise, when `classifier.worker` is set, that worker is given the kind list and the start of the text and answers `{kind, tags, why}`: `source: model`;
4. otherwise the order is unclassified (`source: none`): its explicit or default role determines routing; without one, the order reports `no role`.

This happens when orders are imported or created. A failed classification never stops dispatch.

## Choosing the worker

For each order:

1. Resolve exactly one role: explicit order `role`, then the first matching kind mapping, then `roles.default` or a role marked `default: true`. An unknown explicit role is a configuration error. Without a matching/default role, routing fails clearly with `no role`.
2. Filter workers by every `requires` capability, `workers.avoid`, and `workers.only` when present. An empty `only: []` excludes all automatic candidates. Lists match worker ids, aliases or model families, case-insensitively. Extra order tags remain classifier/skill metadata; they do not create worker fit rules.
3. An explicit worker id or alias in the order overrides the role's capability/avoid/only restrictions. Missing required capabilities are warnings in route reasons and run metadata. Availability and limits still apply.
4. Exclude disabled workers, unreadable/exhausted quota, daily spend limits, concurrency/daily-run limits and missing launch templates, each with its reason. Card workers keep their existing manual-start behavior. Project/resource/memory/order-spend limits still control dispatch.
5. Rank eligible workers: when the resolved route or role sets `rank_by: acceptance` or `rank_by: cost-per-accept` (default `preference`), compare this project's 14-day [scorecard](../console/020-usage-and-cost.md#cost-and-time-per-accepted-order) for the order's kind first (`first_pass_rate` with at least three first attempts and at least a 10-percentage-point gap for `acceptance`; `cost_per_accept` when both workers have a USD figure and at least a 20% gap for `cost-per-accept`), then fall through on ties or missing numbers to ordered role `prefer` (unlisted workers last), this role and worker's accepted-without-rework share (both compared workers need at least three reviewed runs), included before paid, fewer open runs, and file order. Unknown/small-sample yield does not count as zero, and when every effective role uses `preference` the tick does no scorecard work.

Every exclusion and tie-break is visible in `alba route TAG`, the order page, and recorded run-start routing metadata. The role, its resolution source and optional effort/reasoning hints are recorded at launch; hints do not generate engine flags. `alba route` is read-only and starts no model.

Rotation after a capacity ending uses the same role, eligibility and ranking, excluding the exhausted worker and paid targets unless spending is allowed. A qualifying busy target makes the order wait; with no handover target, existing resume/backoff rules apply.

The tick separates `no-fit` problems (missing role or no eligible supply) from `HELD BACK` / `no-worker` (eligible supply currently unavailable). Update role requirements/preferences or worker capability declarations to fix eligibility; update supply availability to unblock a wait.

## Skills

One registry of skills for every worker, whatever its engine. A skill is a folder with a `SKILL.md` whose front matter has `name` and `description` (and may have `tags`):

```
---
name: project-build
description: "How to build and package the UE project: the commands, the order, the usual failures."
tags: [build, automation]
---
```

### The registry

`skills:` in the workers file, a `skills.yaml` next to it, or both (they are put together; a source id used in both is refused) lists sources. A source is a folder; by default each child folder with a `SKILL.md` is a skill (`layout: recursive` finds any `SKILL.md` below it):

```yaml
skills:
  sources:
    - { id: shared, dir: ~/skills }                              # relative folders start at the file's folder
    - { id: build, dir: ~/skills-build, tags: [build], exclude: [old-*] } # tags are added to every skill of the source
    - id: misc
      dir: ~/skills-misc
      skills: { project-build: [build] }                              # extra tags for one skill, by name
```

Two skills with the same name: the first one in the list is used and the other is reported. A skill folder without a name in its front matter gets the folder name. Problems (a missing source folder, a skill with a name that cannot be a folder name, an unreadable `SKILL.md`) are shown by `alba skills`, on the Skills page and as notices; they never stop a run. The registry is read again whenever the workers file or `skills.yaml` changes.

`alba` brings one core skill of its own, `alba-worker-rules` (`templates/skills/`): how a worker works and reports. It is always attached, and the short footer of the prompt points at it.

#### Alba's skill library

The other folders of `templates/skills/` are Alba's skill library. They are in every registry (source `alba`) but, unlike other skills, are never attached because a tag matches: a project, role, order or editor pool names them (`skills.always`, `skills.by_kind`, a role's `skills`, an order's `skills`, `editors.<pool>.skills`). A skill of the same name in another source replaces the library's copy, so a project can keep its own version.

| Skill | For |
|---|---|
| `game-capture-windows` | screenshots and clips of a game on a shared Windows desktop: `scripts/window_shot.ps1` and `scripts/window_clip.ps1` (PrintWindow on the window of the process it started, joined with ffmpeg; under the capture lock), and `scripts/frames.mjs` (contact sheets, mean luminance per frame, black frames, flicker outside named camera cuts, files with identical bytes) |
| `unreal-headless-pipeline` | Unreal builds, packages and content without a person at the editor: the project's scripts, one engine build at a time (UBT exit 10: wait and retry), prebuilt libraries rebuilt before the engine build, headless editor Python, Windows path and junction traps, what counts as evidence |
| `unreal-mcp-editor` | a run's own Unreal editor over MCP ([032](032-run-editors.md)): the meta tools and toolsets, only saved files count, restarting around a C++ build |
| `alba-review-bar` | for reviewers, not workers: the store bar a game delivery is judged against and the ways deliveries cheat; the producer's review sessions follow it with `producer.review_skills` |

```yaml
# alba.yaml of an Unreal project on Windows
skills:
  always: [game-capture-windows]
  by_kind: { ue: [unreal-headless-pipeline] }
editors:
  ue-editor: { ..., skills: [unreal-mcp-editor] }
producer:
  review_skills: [alba-review-bar]
lessons:
  dir: docs/lessons
  packs: [unreal, windows-workers, art-pipeline]   # Alba's lesson packs, see library-formats.md
```

### Three layers

| Layer | What attaches | Where it is set |
|---|---|---|
| core | `alba-worker-rules`, always | the tool |
| project | `skills.always`, `skills.by_kind`, then the resolved role's `skills` | `alba.yaml` and effective `roles` |
| order | skills that share a tag with the order (`tags`), and skills named on the order (`skills:` in its front matter) | the order |

```yaml
# alba.yaml
skills:
  always: [commit-style]
  by_kind:
    build: [project-build]
  max_per_order: 16          # the most skills one order gets (default 16); the rest is listed and left out
```

The cap only leaves out skills nobody else asked for: a role's own additions (the last first) and tag matches. Alba's worker rules, `skills.always`, `skills.by_kind`, a tool plugin's or editor's skill and skills named on the order are always mounted and count towards the cap first; when they alone pass it, the order gets all of them and no role or tag skill.

A name that is not in the registry is reported (and left out), not an error. `alba skills` prints the registry as the project sees it (the skills it can use, then those it cannot with the reason), `--order TAG` the skills that order gets and why.

### Of the machine and of the project

The sources above describe the machine and are the same for every project. A project adds its own folders (`skills.sources` in `alba.yaml`), says which engine it is (`skills.engine`) and which global skills it does not want (`skills.exclude`, names or tags) or wants whatever their engine (`skills.include`). A skill made for another engine (`engines` in its front matter, or sitting in a `unity/` or `godot/` folder of a library) is not used by a project of a different engine, and an order never gets a skill its project does not use. See document 013.

### Putting them in the worktree

At the start of every run (new or resumed) the selected skills are copied into the worktree, into the folder(s) the worker's engine reads. The copy is made from the shared folders, which are never written to, and stays out of git: the folders are added to `.git/info/exclude` of the repository (never to a tracked file), and a manifest (`.alba-skills.json`) records what alba put there so that a later run removes skills that do not apply and never touches a folder it did not create. A path that already exists and is tracked by git is left alone. If anything goes wrong, the run starts anyway; the prompt then carries a table "skills for this order" (name, what it is for, path) as a fallback for workers whose engine did not find the folder.

Where each engine reads (each found by running that engine on a worktree with one probe skill in every place it might look, and asking it to list its skills):

| Engine | Folders read inside the worktree | alba puts them in | Notes |
|---|---|---|---|
| `codex-cli` | `.agents/skills`, `.codex/skills` | `.agents/skills` | Also reads the user's own skills and plugins; see isolation below. |
| `claude-cli` | `.claude/skills`, `$CLAUDE_CONFIG_DIR/skills` | Both the worktree's `.claude/skills` and the worker's isolated config `skills/` | Alba supplies a separate config directory and only explicitly named environment values; see [003](003-workers-and-quota.md#an-isolated-claude-cli-worker). |
| `grok-cli` | `.agents/skills`, `.grok/skills` | `.agents/skills` | Only in a folder it **trusts**: without `--trust` it reads none of them. The worker's `launch.args` need `--trust` for skills to arrive (the worktree is one alba made for this order). |
| `agy-cli` | `.agents/skills` (not yet confirmed with the probe skill) | `.agents/skills` | |
| `opencode` | `.agents/skills`, `.claude/skills`, `.opencode/skills` | `.opencode/skills` | `.agents` and `.claude` are "external" and can be switched off; `.opencode` stays. |
| `claude` (cards) | – | – | A person starts the session; the card lists the skills. |

`skills_mount: [path, ...]` on a worker overrides the folders (relative to the worktree, no `..`).

### Isolation: only the skills alba chose

By default an engine also reads the user's own skills (home folder, global config, plugins). That is often what a person wants on their own machine and is **not** changed by alba. When a worker should see only what alba gave it, add the engine's switch to the worker's `launch`. These were each tried with the same probe:

```yaml
# codex-cli: built-in skills and the worktree's own remain, the user's and plugins' go
launch:
  args: [exec, ..., -c, features.plugins=false, -c, features.skip_host_skill_discovery=true, ...]

# opencode: DISABLE_CLAUDE_CODE_SKILLS drops ~/.claude and .claude; DISABLE_EXTERNAL_SKILLS drops .agents too;
# the permission rule leaves exactly the skills alba attached ({skill_allow} is expanded at each run start)
launch:
  env:
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true"
    OPENCODE_PERMISSION: '{"skill":{"*":"deny",{skill_allow}},"external_directory":{"../work-orders\\*":"allow"}}'
    # external_directory: `opencode run` refuses, without asking, to read a file outside the worktree, and the order file
    # lives in the project's work-orders folder; without this entry the run ends at once with no report (found by trying).

# grok-cli: nothing to switch off; it reads project skills only in a trusted folder
launch:
  args: [--trust, ...]
```

`launch.env` values may use `{skill_names}` (comma separated) and `{skill_allow}` (`"name":"allow"` pairs, for a JSON object). Any other placeholder in `env` is refused when the workers file is read.

What stays outside alba's reach: an engine's built-in skills (Codex ships a few of its own), and anything the user installed in a place the switches above do not cover.

### Suggestions from workers

A worker never edits a shared skill. If one is wrong or missing something it says so in the report block, `"skill_suggestions":[{"path":"project-build/SKILL.md","reason":"one sentence"}]`. The suggestions are kept with the report, shown under "Skills for this order" and in `GET /api/orders/:tag/skills`; a person decides.

### In the console

The order page shows *Who takes it* (the kind, its source and reason, the resolved role first, its chosen worker, and every candidate with preference, cost, role yield and verdict) with the buttons *Classify again* and *Ask the classifier*, and *Skills for this order* (layer and reason for each skill, where they are put, what workers suggested). The run list shows why each run's worker was chosen and which skills it got. The Workers page shows supply capabilities, model, route, quota, cost, limits and notes; the Routing page shows the worker groups, then each route (or earlier role) with its viewable rules, current eligibility and results; the Skills page shows the registry, the sources, the project layer, who uses each skill and where each engine finds them.

## Routing: worker groups and routes

Routing is the layer above the workers. It says who does which kind of work, in one place:

- A **worker group** is a named, ordered list of workers (ids, aliases, model families or other groups). The first available one
  takes the order; when it is busy, out of quota, over its spend cap or switched off, the next one does. `"*"` at the end means
  "then anyone else" (any other worker the route does not avoid); without it, nobody outside the group is chosen.
- A **route** sends kinds of work to a group, with the capabilities those orders need.
- `routing.default` names the group of orders no route takes, and `routing.avoid` lists workers no route chooses by itself.

```yaml
# workers.yaml (shared) or alba.yaml (this project)
routing:
  groups:
    main:  [codex, claude-sonnet]       # in order; the next one when the first cannot start now
    cheap: [grok, opencode, "*"]        # then anyone else
    all:   [main, cheap]                # a group may name groups
  default: main                         # orders that no route takes
  avoid: [claude-opus]                  # never chosen by a route (an order that names it still gets it)
  routes:
    ue:   { kinds: [ue, build], group: main, requires: [shell, git, windows], rank_by: cost-per-accept }
    art:  { kinds: [art], group: cheap, avoid: [grok], rank_by: acceptance }
    docs: { kinds: [docs, research], group: all }
```

Changing a group changes every route that uses it: "Codex first everywhere" is one edit of `main`.

How a route resolves:

- The order's route is its explicit `role` (`--role`), else the first route whose `kinds` has the order's kind, else the default.
  An order whose worker text names a worker still goes to that worker, as before.
- The group's workers, in order, are the route's preference; without `"*"` they are also the only workers it may use. Within the
  group the usual rules choose: required capabilities, availability, limits, optional `rank_by` (`preference`, `acceptance` or
  `cost-per-accept`), then the group's order, accepted-without-rework share, included before paid, load and file order
  ([Choosing the worker](#choosing-the-worker)). Any other `rank_by` value fails configuration validation naming the key (on both
  `routing.routes.<id>.rank_by` and legacy `roles.<id>.rank_by`). When `rank_by` decides or falls back, `alba route` states the
  14-day numbers (`cost per accepted ue order $12 vs $41 (5 and 4 accepted, 14 days)`, `first pass 80% of 10 ue orders vs 45% of 11`,
  or `rank_by cost-per-accept: no dollar figure for codex (included)`).
- A route may also write `workers: { prefer, avoid, only }` instead of `group` (not both `group` and `prefer`/`only`).
- Routing in `alba.yaml` adds to the workers file's: a project group replaces the shared group of the same name, a project route the
  shared route of the same name (a project route with its own worker list drops the shared route's group).
- A group member that names no worker, a group that contains itself and a route with an unknown group are errors when the files are
  read.

A route only routes. `skills`, `mcp`, `rules`, `tools` and `effort` are refused on a route, with where they belong instead: skills by
kind under `skills.by_kind`, MCP servers and tools as [tool plugins](031-tool-plugins.md) under `plugins.by_kind`, standing rules
as a skill, effort in the worker's launch template.

```sh
alba routing                 # groups with their workers in order, routes, and who qualifies now (--json for the view)
alba routing migrate         # the routing that replaces each file's roles, and where their skills, MCP servers and rules go
alba route <TAG>             # who takes one order and why: "group main #2", "not in worker group main"
```

`alba routing migrate` writes nothing. Each role becomes a route; a role that limited its workers (`only`) gets a group with them in
its preferred order, one that only preferred some gets a group of those followed by `"*"`, roles with the same list share a group,
and a worker that two routes or more avoided (and no route could otherwise reach) is written once under `routing.avoid`. The routing it prints chooses the same worker as the
roles did. Replace `roles:` with it in that file (a file may have `roles` or `routing`, not both).

The console's **Routing** page shows the groups (their workers in order and the routes that use them) and each route with its
candidates and results. `GET /api/roles?project=` answers `{ roles, groups }`.

## Roles (the earlier form)

`roles` is still read, in the workers file and in `alba.yaml`, and routes the same way; routes are roles that only route, and `alba routing migrate` prints the routing that replaces a file's roles. A role defines the job: kinds, required capabilities, skills, MCP servers, standing rules and ordered worker preferences for one run. Define `roles` in the workers file for shared defaults and in `alba.yaml` for project overrides. The producer remains the coordinating layer.

```yaml
roles:
  art:
    description: Artwork and visual checks
    kinds: [art, illustration]
    requires: [vision, mcp]
    effort: high                 # recorded hint only
    skills: [image-workflow]
    rules: rules/art.md
    workers:
      prefer: [visual-worker]
      avoid: [text-only-worker]
      only: [visual-worker, visual-family]
    mcp:
      image:
        command: image-tool-server
        args: [--stdio]
        env_from: [IMAGE_API_TOKEN]
        engines: [claude-cli, codex-cli, opencode]
  engine-programmer:
    description: Engine builds and gameplay code
    kinds: [engine, gameplay]
    skills: [engine-build, engine-debugging]
  default:
    description: General work with no matching kind
    requires: [shell]
  designer:
    description: Design using read-only project queries
    kinds: [design]
    mcp:
      project-query:
        command: project-query-server
        args: [--stdio, --read-only]
```

The example commands are placeholders for installed servers. A server's read-only mode must be provided by that server; the role does not enforce it. Skill names must exist in the skill registry.

Project values replace shared values for the keys present in the project. Lists replace lists. `workers.prefer`, `workers.avoid` and `workers.only` merge separately; `mcp` merges by server name, with each project server replacing that server's complete `{command, args, env_from, engines}` definition. An empty list clears an inherited list. Shared role order is retained, with project-only roles appended in project order. The first matching `kinds` entry wins. Rules paths resolve relative to the file that defines the path, even when other keys come from another file.

An explicit order `role` wins over the kind mapping, then the default role is used. Define only one default across the merged configuration. Without any match the order fails routing with `no role`. Use:

```sh
alba orders add <TAG> --title "Prepare artwork" --kind art --role art
alba orders set <TAG> --role designer
alba orders set <TAG> --role ""      # restore kind-based selection
alba roles list
alba roles show art
alba route <TAG>
```

`roles list` and `roles show` print the effective definition, per-key source files, candidate eligibility and role/worker results (JSON, also with `--json`). `route` shows the role and source (`explicit`, `kind`, `default`, `none`), required capabilities, contributed skills, servers, rules path and preferences. A named id or alias overrides role restrictions with capability warnings, while quota and limits remain enforced. Role preference precedes reviewed yield, cost, load and file order.

Role skill names are added after `skills.always` and `skills.by_kind`, before order skills and tag matches, and deduplicated. The project's existing include/exclude and engine applicability rules apply, including the existing exemption for project-owned skills. Role additions obey `max_per_order` and are the first left out (the last named first) when the selection passes it; a role never pushes out a core, project, tool, editor or order-named skill, and a role skill the order also names is kept. Unavailable skill names appear as problems in the skills view.

Rules are read again at every launch, including resume and handover, and prefixed under `## Role rules` before the work-order pointer. `alba prompt` previews them too. Missing rules files fail before a process starts.

### Sticky producer worker selection

A producer `reroute` stores an optional `order.next_worker` id without rewriting the original free-text worker hint. It wins over role ranking, resume selection and automatic quota rotation on every later dispatch. The selected worker must still declare every capability in the resolved role's `requires`; a producer pin never uses the capability-warning override allowed for a person's explicit worker choice. A removed or disabled worker, or a pin missing newly required capabilities raises a visible tick problem; a recording tick drops the pin and records why, restoring normal routing. Previews report the problem without changing state. Quota, spend, daily-run, concurrency, resource and project caps still apply; a full worker leaves the order queued.

The pin remains until another reroute or a person's worker update (`orders.update` with `worker`, including the original hint), which clears it atomically. Clearing the worker cell in a table import also clears the pin. Only an explicitly supplied worker (`run --worker`, API body `worker`, or answer `options.worker`) clears the pin as a person start and retains the chosen worker as the new hint; an inferred or cached worker cannot override a healthy pin. API run requests without a worker prefer the live pin over a cached tick. Producer dispatch drops an unfit pin with its configuration reason and preserves the person's hint. Table imports compare the worker cell with its last imported or written value, so an unchanged table and the tool's own writeback preserve later pins. A person's explicit choice bypasses producer escalation guards. Answers and message restarts prefer an existing pin and carry its first-run brief. A running process is unaffected by a worker update. The board exposes `nextWorker` separately from the current run's worker, and the routing preview uses the same pin as dispatch. The first run after reroute receives a bounded host-built previous-attempts brief and a fresh session; later runs keep the selection without repeating that brief. See [producer escalation policy and guards](../producer/021-producer.md#escalating-hard-work).

### MCP adapters

Only environment variable **names** belong in `env_from`. Missing variables fail before launch. Literal values under keys resembling key, token, secret or password are rejected without echoing the value; an `env` value mapping is also refused. Supply credentials in the environment of the alba process. Generated files and arguments contain variable references or names; values enter only the child environment. Run-start metadata records role/source, mounted server names and warnings, with no environment values.

| Engine | Role MCP mechanism | Confirmation |
|---|---|---|
| `claude-cli` | Ignored `.alba/role-mcp.json`, `--mcp-config`, `--allowedTools mcp__<server>__*`; `${NAME}` references | [CLI reference](https://code.claude.com/docs/en/cli-reference), [MCP environment expansion](https://code.claude.com/docs/en/mcp) |
| `codex-cli` | `-c mcp_servers.<server>.command=...`, `.args=...`, `.env_vars=["NAME"]`; values stay out of argv | `codex --help`, [configuration reference](https://developers.openai.com/codex/config-reference/) |
| `opencode` | Ignored `.opencode/opencode.json`, current v2 `mcp.servers` local command/environment schema, `{env:NAME}` references | [config locations](https://opencode.ai/docs/config/), [MCP servers](https://opencode.ai/docs/mcp-servers/) |
| `grok-cli` | Servers skipped; run-start warning `role X: MCP servers not mounted for engine Y` | `grok --help` and `grok mcp add --help` expose persistent config; a per-run config flag/schema was not confirmed |
| `agy-cli` | Servers skipped with the same warning | `agy mcp` manages persistent config only; no per-run flag |
| Other / card engines | Unknown mechanisms are skipped with the same warning; cards are started by a person | No guessed flags |

A server's optional `engines` list limits it to those engines; absent or empty means all. Filtering out a server produces no unsupported-engine warning. OpenCode generation refuses an existing unmanaged config instead of replacing it. A checksum identifies the generated file; the next launch removes it (also when the next run has no role), and refuses to remove a file that was edited. Claude's ignored JSON is passed explicitly, so a later run without a role does not load it through the adapter. Existing engine/user configuration still follows each engine's normal loading rules.

The order page has a role selector and the complete role contribution beside routing reasons. `GET /api/roles?project=...` returns definitions, sources and results; order creation accepts `role`; `POST /api/orders/:tag/role` takes `{project, role}` (empty role restores inference). Role edits are stored as order-update events and affect the next launch. The Routing page lists the worker groups and the definitions, current qualifying workers, exclusion reasons, viewable rule text and lifetime worker results; the Usage page shows results for its selected period.

### Role × worker results

Completed, non-imported runs are grouped by the role and worker recorded at launch. Old runs without a recorded role remain unattributed. Editing a role or kind mapping does not rewrite history. Each run gets its first `approve` or `rework` before the next run starts; pending reviews are excluded from that denominator. The share is accepted runs divided by reviewed runs. Medians use completed run token totals and wall-clock start/end duration, including runs awaiting review. Multiple usage turns are summed once per run; a missing token total remains unknown.

Shares require three reviewed runs; token and wall-time medians each require three known observations. Smaller samples show **not enough runs**, with counts still visible. Usage windows select by run end, with reviews known by the snapshot boundary. Producer snapshots expose the same calculation in both 24-hour and seven-day windows as `F:role.<role>.worker.<worker>.samples`, `.accepted`, `.first_pass_yield`, `.tokens_p50`, `.hours_p50` and `.assessment`, followed by `.24h` or `.7d`. Identifiers are URL-encoded. Insufficient numeric comparisons are `null`, and assessment is `not enough runs`.


### Producer supply and waiting facts

Each snapshot exposes `F:role.<role>.qualifying_workers`, `.no_qualifying_worker`, `.queue_hours` and `.queue_wait_p50`, followed by `.24h` or `.7d`. Availability uses the tick quota/limit snapshot; missing availability is unknown (`null`). Queue durations are clipped to the selected window and include queued dependency waits. A no-qualifying-worker fact becomes a producer role constraint. Yield facts keep the review/sample rules above. Role ids are URL-encoded in fact ids.
