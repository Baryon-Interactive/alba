# 033. Adopt Alba in your own project

This page takes an existing game repository (any engine, or none) from nothing to a first order run by a worker. It assumes
one machine and one Codex or Claude subscription; everything else ([routing](../workers/012-routing-and-skills.md#routing-worker-groups-and-routes), kinds, caps,
remote machines, the producer, tools) can be added later.

You need Node 24, Git and Alba, either as a checkout (`pnpm install --frozen-lockfile`, and `pnpm -C ui build` for the
console), run with `node <alba>/bin/alba.mjs`, or installed as a package: `npm pack` in a checkout makes a tarball (it builds the
JavaScript and the console first), and `npm install --global <tarball>` (or `pnpm add`) gives an `alba` command. Below,
`alba` stands for either. Run the [demo](../../examples/demo/README.md) once first, from a checkout: it shows the whole loop
without a model.

## 1. Two files next to your repository

```yaml
# alba.yaml (in your repository or next to it; relative paths start at this file's folder)
id: mygame
name: My Game
root: .                      # the git repository the orders change
work_orders: orders          # one Markdown file per order: <TAG>-<name>.md
state_dir: .alba             # Alba's state (orders, runs, logs); keep it out of git
workers: workers.yaml
# Optional, with their defaults:
# dispatch:
#   worktree_parent: ../mygame-worktrees   # default: <id>-worktrees next to the repository
#   base_ref: main                         # default: main if the repository has it, else the branch it is on
#   sparse: [Source, Config]               # optional: cone-mode directories for new worktrees
#   checkout_workers: 4                    # optional: git checkout.workers for sparse worktrees (default 4)
#   port_base: 8100                        # optional: sets ALBA_PORT_BASE = port_base + ALBA_SLOT * port_block
#   port_block: 10                         # optional: port stride per run slot (default 10)
# skills: { engine: godot }                # unreal, unity, godot, other (no engine skills) or any
```

```yaml
# workers.yaml: one worker on a Codex subscription (`codex login` done on this machine)
workers:
  - id: codex
    engine: codex-cli
    cost: included
    concurrency: 1
    launch:
      program: codex
      model: gpt-5-codex      # a model your account may use
      args: [exec, "{session_args}", -m, "{model}", -o, "{last_file}", "Read the UTF-8 file {prompt_file} in full and follow it exactly."]
      session:
        new: [-C, "{cwd}", -s, danger-full-access]
        resume: [resume, "{session_id}", -c, 'sandbox_mode="danger-full-access"']
```

For a Claude subscription instead, run `claude setup-token` once and put the token in the environment of the process that
starts Alba as `CLAUDE_CODE_OAUTH_TOKEN`. A Claude worker gets a configuration folder of its own (only the skills Alba chose),
so it does **not** see your own `claude` login; it must be given the token:

```yaml
workers:
  - id: claude
    engine: claude-cli
    cost: included
    concurrency: 1
    launch:
      program: claude
      model: sonnet
      args: [-p, --output-format, stream-json, --verbose, --model, "{model}", --permission-mode, bypassPermissions,
             "Read the UTF-8 file {prompt_file} in full and follow it exactly."]
      env:
        CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN}'   # or ANTHROPIC_API_KEY for the API
```

`alba workers` lists the workers and says why one cannot be used (no launch template; a Claude worker that names no sign-in is
reported on every pass). With no `routing` written, every order may go to any worker; write routing when several workers should
split the work ([012](../workers/012-routing-and-skills.md)).

Keep Alba's files out of your commits: add the state folder (`.alba/`) to `.gitignore`. The `orders/` folder may be
committed (the orders are part of the project's history) or ignored, as you prefer.

## 2. The first order

```sh
alba() { node <alba>/bin/alba.mjs --project alba.yaml "$@"; }   # installed as a package: alba() { command alba --project alba.yaml "$@"; }
mkdir -p orders
printf '# T1 Add a README section\n\nAdd a "How to build" section to README.md.\n\n## Acceptance\n- README.md has the section; nothing else changes.\n' > orders/T1-readme.md
alba orders add T1 --title "README build section" --kind docs --queue
alba workers                     # is the worker available?
alba route T1                    # who would take it, and why
alba run T1 --worker codex --dry-run   # checks the order file, the base branch and the worker without starting anything
alba tick                        # starts it for real (one order per pass)
alba status                      # follow it; `alba watch T1` streams its activity
```

The worker works in its own worktree (`../mygame-worktrees/mygame-t1`) on branch `mygame-t1`, commits there and ends with a
report. Review it on the console (`alba serve`, then open the printed address) or with `alba review T1 approve|rework`.

## 3. Write the foundations before the first content order

Before the first order that makes content (art, levels, sound), write the documents that content must follow: for art, an art bible with direction, palette, value ranges, a scale ruler, material classes, lighting presets, effect sizes and an acceptance list. List them under `design_docs` and name them in `foundations`, so that content orders wait for them (`mode: block`) or at least say on every tick that they are missing (`mode: warn`):

```yaml
design_docs:
  files:
    - { id: art-bible, path: design/art-bible.md, status: draft }
foundations:
  mode: block
  art: { kinds: [art], docs: [art-bible] }
```

The order that writes them is tagged `foundation` (`alba orders add F1 --title "Art bible" --kind art --tags foundation`), so it is not held back itself. Set the document's status to `approved` once a person has read it; `alba foundations` shows what is still missing ([design intake](../libraries/030-design-intake.md#foundations-before-content-orders)). Turn on the `art-pipeline` lesson pack too (`lessons: { packs: [art-pipeline] }`).

## 4. What to add next

| Need | Where |
|---|---|
| Several workers splitting the work by kind, preferences, fallbacks | [routing: worker groups and routes](../workers/012-routing-and-skills.md#routing-worker-groups-and-routes) |
| One build at a time, shared devices | `dispatch.caps`, `resources` ([014](../workers/014-monitor-leases-loops.md)) |
| Skills for your engine, and Alba's built-in ones (`game-capture-windows`, `unreal-headless-pipeline`, ...) | [skills](../workers/012-routing-and-skills.md#albas-skill-library) |
| Documents a kind of work needs before its orders start | `foundations` ([design intake](../libraries/030-design-intake.md#foundations-before-content-orders)) |
| Rules every order should carry | `lessons` and Alba's lesson packs ([library formats](../library-formats.md#lessons)) |
| A game editor with MCP for each run | [032](../workers/032-run-editors.md) |
| Paid tools (pictures, 3D models) with quotes | [031](../workers/031-tool-plugins.md) |
| Remote machines | [028](../operations/028-machines.md) |
| An AI producer that drafts and reviews orders | [021](../producer/021-producer.md) |

## When something does not start

| Message | What to do |
|---|---|
| `No work-order file for T1` | Write `orders/T1-<name>.md` (or give `--body-file` to `orders add`). |
| `Base ref refs/heads/main does not exist` | Set `dispatch.base_ref` to the branch work starts from. |
| `nobody takes it` / `no role for kind` | Roles are written but none takes this kind: add the kind to a role, or a `default` role. |
| `it has no launch template` | Give the worker a `launch` (program and args). |
| A Claude worker fails as not logged in | Give it `CLAUDE_CODE_OAUTH_TOKEN` (or an API key) in `launch.env`, see above. |
