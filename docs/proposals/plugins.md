# Proposal: plugins and tools

Status: **proposal, partly implemented.** The tool manifest, the built-in and project plugin folders, the `agent` face through the role
mount, tool resources, `alba plugins list / show / doctor`, operations with the tool job runner (`alba tools run`, quotes on the order,
`plugins.auto_approve`) the producer's `tool-call`, plugin settings and the first two tools (`image-gateway`, `tripo-3d`) are implemented and described in [031. Tool plugins](../workers/031-tool-plugins.md). Everything else below is still a proposal unless it says "today".

## Why

Image generation, 3D modelling, audio and similar services are coming into projects one by one, and each one has been wired in by hand:

- Image generation goes through a gateway whose rules live in a project file (`docs/image-rules.md` in the first game project) and in a
  sentence added to every launch line ("Codex's built-in image generation tool is disabled...").
- 3D modelling is a worker of its own (`codex-tripo`): an engine, an MCP configuration with an `enabled_tools` list and a rule ("the
  Tripo tools are the plugin's tripo_* tools only") all packed into one launch template. A rework note could not override that rule,
  because it sits on the command line of every run.
- Audio is a separate MCP server that each agent session configures for itself.

The spend gate (`alba credits quote` / `gate`), resources and leases, evidence and review already exist, but no tool is connected to
them. Every new tool repeats the same work in a different place. A plugin is the unit that does that work once: **it connects one
outside capability to the order lifecycle.** It does not reimplement the service.

## What stays in the core

These parts define what is true and what is allowed. Plugins read them, or write to them through the same calls a person's action
uses. They do not replace them.

| Core | Why it is not a plugin |
|---|---|
| Orders, the event store and stage inference (`orders`, state stores) | The one source of facts; a second writer could contradict it (philosophy rule 2) |
| The run lifecycle: launch, finish, resume, `say`, `answer`, the report block | Every engine and every tool relies on the same meaning of a run and its report |
| Scheduling: tick, plan, caps, resources and leases | Concurrency and exclusive resources only work when one place decides them |
| Review, approval, merge and the acceptance pipeline framework | The boundary of what reaches the base branch |
| Spend: quotes, the credits gate, spend caps, the usage ledger | The money boundary (rule 5): a plugin may *price* a call; only the core *approves* and *counts* it |
| Remote transport (push, LFS objects both ways, results, the desktop helper) | Every tool on another machine goes through it |
| The machines registry, evidence listing, API, serve, CLI, i18n | What plugins are mounted on |

## What becomes a plugin

| Kind | Provides | Today |
|---|---|---|
| `engine` (worker engine) | launch preparation, stream parsing, usage, resume, verifier hooks | `WorkerAdapter` in `src/workers/adapters` (Codex CLI, Claude CLI, Grok CLI, OpenCode, script); [worker adapters](../worker-adapters.md) |
| `game-engine` | capability probe, install plan, suggestions, default skills | `EngineModule` in `src/machines/engines` (Unreal, Unity, Godot) |
| `tool` (new) | a service workers and Alba can call: how to reach it, how to use it, what it costs, what it holds, what it produces | wired by hand per project (see above) |
| `check` | a delivery or acceptance check over the branch and its evidence | general checks in `src/check`, PNG summary in `src/verify/png.ts`, the evidence check and contact sheet in `src/review` |
| `viewer` | how the console shows an evidence type (a `.glb` model, an audio clip, a clip with frames) | images and video only |
| `quota` | how a service's usage window or balance is read | quota sources in the workers file |

The large optional features stay first-party **modules**, switched on per project: producer, design library, art library, ledger,
lessons, table import, sync. They need clear boundaries, but there is no case for third parties replacing them, so they are not
loaded as plugins.

## A tool plugin

A tool has two faces:

1. **For agents.** An MCP server, a CLI or an HTTP gateway, plus a skill that says how to use it. Workers call it inside a run, as
   they do today.
2. **For Alba.** Named **operations** with an input schema, a quote and an output description. Alba can run an operation itself,
   without an agent: for the producer, and for batch work ("generate twenty variants, put them on a pick sheet").

### Manifest

```yaml
# plugins/tripo-3d/alba-plugin.yaml
id: tripo-3d
version: 1.2.0
apiVersion: 1
kinds: [tool, viewer]
description: Text and image to 3D models through Tripo Studio.

agent:                               # face 1: what a worker gets when an order uses this tool
  mcp:
    tripo:
      command: tripo-mcp
      args: [--stdio]
      env_from: [TRIPO_API_KEY]      # names only, never values (rule 6)
      enabled_tools: [tripo_quote_operation, tripo_generate_model, tripo_task_wait, tripo_export_model, tripo_download]
  cli: { program: tripo, fallback: true }   # allowed when the order or a note asks for it
  skill: skills/tripo-3d                    # usage, quoting, file layout; an order or note may override its defaults

operations:                          # face 2: what Alba itself can call
  generate-model:
    input: schemas/generate-model.json
    quote: { operation: tripo_quote_operation, unit: credits }   # priced before it runs
    run: { mcp: tripo, tool: tripo_generate_model, wait: tripo_task_wait }
    output: { files: ["*.glb", "*.fbx"], evidence: true }

machines:
  probe: [tripo, --version]
  install: { windows: [winget, install, Tripo.CLI] }

resources: { tripo-wallet: { slots: 2 } }     # merged into the project's resources; a run or operation leases it
checks: [checks/model-sanity.mjs]             # code part: polygon count, scale, UVs present
viewers: { ".glb": viewers/glb.mjs }          # code part: the console's model preview
```

Only `checks` and `viewers` need code. Everything under `agent` and `operations` drives outside processes, so a tool without code
runs no code inside Alba.

### How an order uses a tool

1. The order names its tools (`tools: [tripo-3d]`), or its kind does (`kinds: { model: { tools: [tripo-3d] } }`).
2. **Routing:** only machines whose probe found the tool qualify, and the tool's resources must have a free slot, like any other
   resource.
3. **Launch:** the role mount, today used for role MCP servers, mounts the tool's MCP server and skill for the engine and injects the
   named secrets from the environment. The prompt lists the tools of the run with their quote limits, like **Slots this run holds**.
4. **Paid calls:** the skill tells the worker to quote, and `alba credits gate` checks every call against an approved quote, as
   today. The difference is that the tool brings the pricing, so no project has to write it again.
5. **Delivery:** the tool's checks run with delivery lint and acceptance, its outputs are listed as evidence, and the review page
   uses its viewer and the contact sheet.

With this, `codex-tripo` disappears. Tripo becomes a tool that any engine's worker can be given, and "plugin tools only" becomes a
default in the tool's skill that an order or a note can change.

### Operations run by Alba: the tool job runner

A small runner in the core executes operations:

- It queues them per tool, takes the tool's resources as leases, and asks for a quote before a paid call. The quote is approved
  according to the spend policy: automatically under a cap, or as a card for a person.
- It runs the operation, stores the outputs as evidence of the order or case it was run for, and writes usage to the ledger.
- It records each step as events, so the stage of an order is still computed from facts.

Callers:

- **People**: `alba tools run <tool> <operation> --order <TAG> --input file.json`, and a button in the console.
- **The producer**: a new action kind `tool-call` in `producer_act`. It goes through the same policy check, case revision and budget
  as other producer actions. Typical uses: concept images for a design decision, a quote for a model before an order is written,
  sound variants for a pick.
- **Workers**: `alba tools run` from inside a run when the tool has no agent face for their engine (for example, Grok has no per-run
  MCP mount today).

## Roles

Today a role carries kinds, `requires`, worker preferences (`prefer` / `avoid` / `only`), `skills`, `mcp`, `rules` and
an `effort` hint. In the first game project only the worker preferences and kinds are used. They carry the owner's routing rules (one
model first, another never, no orders to one worker). `mcp`, `skills`, `rules` and `effort` are unused, and `mcp` and `skills` are exactly
what a tool plugin provides.

Proposal: **keep roles, but only for routing.**

- A role keeps `kinds`, `requires` and `workers`. It says what kind of job this is and who should do it.
- `mcp` and `skills` move to tools. A role may list default tools (`tools: [image]`), which are mounted through the plugin.
- `rules` move into skills or the order template.
- Old keys keep working during the change. `alba config doctor` names each one and where it now belongs.

Removing roles entirely would put the routing rules back into every order or kind, so it does not pay.

## Where plugins come from

All plugins use one manifest format and one loader. They differ only in where they come from and how far they are trusted.
Precedence, lowest first:

1. **Built in.** `plugins/` in the Alba repository, released with Alba:
   - the engine adapters and game-engine modules of today;
   - the PNG and evidence checks and the contact sheet;
   - image generation through a gateway, Tripo 3D and an audio tool;
   - a `.glb` viewer.

   Moving the existing adapters there first proves that the interfaces are enough.
2. **The project's own.** A folder named in `alba.yaml`, for example `tools/alba/plugins/`, for tools only that project uses.
3. **Third party.** Sources listed in `alba.yaml`, resolved by `alba plugins add` into a local cache and pinned in
   `alba-plugins.lock`:

```yaml
plugins:
  enable: [tripo-3d, image-gateway, audio-studio]
  sources:
    - { path: tools/alba/plugins }
    - { git: https://example.com/studio/alba-plugin-foley.git, ref: v0.3.1 }
    - { npm: "@studio/alba-plugin-sprites", version: 2.1.0, trust: code }
```

### Making third-party plugins easy to add

- `alba plugins new <id> --kind tool`: scaffolds the manifest, a skill, an MCP stub and a test.
- `alba plugins doctor [<id>]`: checks per machine whether the tool is installed, whether its named secrets are present, whether its
  MCP server starts and lists the declared tools, and whether a quote call works.
- `alba plugins test <id>`: Alba's contract tests. They validate the manifest, dry-run each operation against a stub, and run the
  plugin's own checks on fixture evidence.
- A complete example tool plugin in the repository, to copy.
- `apiVersion` in every manifest. The loader refuses a plugin it does not understand and says which Alba version it needs.

### Trust

- A plugin without code is enabled by listing it. It starts outside processes with their arguments as a program and an argument
  list, never a shell. It sees only the secrets it names, and only at launch.
- A third-party plugin with code (`checks`, `viewers`, `engine`) is loaded only when the project says `trust: code` for it. A
  built-in or project plugin is trusted because it is in the repository.
- Whatever its trust, no plugin approves a quote, records a spend, merges, or changes an order's stage. Those calls are not in the
  plugin API.
- Secrets never enter prompts, logs or the lock file (rule 6). The doctor reports a missing secret by name only.

## Plugin API (code part)

```ts
export default definePlugin({
  id: 'tripo-3d', apiVersion: 1,
  checks: [{ id: 'model-sanity', files: ['*.glb'], run: async (file, ctx) => ({ ok, detail }) }],
  viewers: [{ extension: '.glb', module: './viewers/glb.mjs' }],
});
```

The engine adapter (`WorkerAdapter`) and game-engine module (`EngineModule`) interfaces are kept as they are and are exported from
this API, so that today's adapters move without change. A check receives only read access: the worktree, the evidence files and the
order's report.

## Steps

1. **Interfaces in place, no behaviour change.**
   - Registries for engines, game engines, checks and viewers.
   - The built-in adapters and modules move to `plugins/` and are loaded through the registry.
   - Tests prove that every existing launch, probe and check is unchanged.
2. **Tools.**
   - The manifest, the loader, and the `agent` face through the role mount.
   - The tool job runner with the quote gate, leases and evidence.
   - `alba tools run` and the producer's `tool-call`.
   - First tools: image gateway, Tripo 3D, audio.
   - Done when `codex-tripo` and the image sentence in launch templates are deleted from that project.
3. **Roles slimmed.** Role `mcp` and `skills` read through tools; `alba config doctor` points at what to move.
4. **Third party.** Sources, the lock file, `plugins new` / `doctor` / `test`, and trust levels.

## Open questions

- Does a tool operation without an order exist (for example, a producer case that has no order yet), and where are its outputs
  kept? The proposal stores them on the case and copies them into an order when one is written.
- Should a project be able to pin a plugin's version per machine? Remote hosts may lag behind.
- Spend policy for operations the producer starts: always a card, or automatic under a per-tool cap?

## Not proposed

- A marketplace or automatic updates: plugins are added and upgraded by a person, pinned in the lock file.
- Plugins that edit orders, stages, quotes or spend: they would break facts-in, state-out (rule 2) and no-surprises-with-money
  (rule 5).
- Plugins inside the agent engines themselves (Codex plugins, Claude skills): Alba mounts what a tool provides, but each engine's
  own plugin system stays that engine's.
