# 031. Tool plugins

A **tool plugin** connects one outside service (image generation, 3D modelling, audio, ...) to the orders that use it. It brings what
each project used to wire into launch templates by hand: the MCP server and which of its tools a worker may call, the skill that says
how to use it, the resources it holds, and how a machine shows that it is installed. The design and the later steps are in the
[plugins proposal](../proposals/plugins.md); this page describes what is implemented.

## What a plugin is

A folder with an `alba-plugin.yaml`:

```yaml
id: mesh-studio                 # the folder name; lower-case letters, digits and "-"
version: 1.0.0
apiVersion: 1                   # the manifest version this Alba reads; another one is refused with what it needs
kinds: [tool]
description: Text and image to 3D models.

agent:                          # what a worker gets when its order uses the tool
  mcp:
    mesh:
      command: mesh-mcp         # a program and arguments, never a shell
      args: [--stdio, "${plugin}/config.json"]   # ${plugin} is the plugin's folder
      env_from: [MESH_API_KEY]  # names only; values are refused
      tools: [mesh_quote, mesh_generate, mesh_download]   # only these are offered (absent: all)
      engines: [codex-cli, claude-cli]                    # optional: only for these worker engines
  skill: skills/mesh-studio     # a folder with a SKILL.md, inside the plugin
  cli: { program: mesh, fallback: true }                  # optional command line program

machines:
  probe: [mesh, --version]      # exits 0 where the tool is installed

resources:                      # held by a run that uses the tool
  mesh-wallet: { slots: 2 }

settings:                       # values the project gives (plugins.settings.mesh-studio); never secrets
  region: { description: The service region., default: eu }
```

**Settings.** `${setting.<name>}` may stand in a command, an argument, an `env_from` name and the probe; the project's value (or the
default) is put in when the project enables the tool. A setting without a default must be given. An `env_from` entry that comes out
empty is dropped, so a setting can say which variable holds a key, or that none is needed. Settings are for base URLs, models and
paths; a key stays in the environment and is named in `env_from`.

**Servers for operations only.** `workers: false` on a server of `agent.mcp` keeps it from workers; only the tool's operations call it
(for example a program that drives a service through several steps).

`agent` needs at least one of `mcp`, `skill` and `cli`, unless the tool has `operations` (see below) and nothing for workers. Keys a later
manifest version will use (`checks`, `viewers`, `engine`, `quota`) are refused by name rather than ignored. A plugin of this version runs no code inside Alba: its MCP server and CLI
are outside processes.

## Where plugins come from

| Origin | Folder | Enabled by |
|---|---|---|
| Built in | `plugins/` of the Alba repository | listing it under `plugins.enable` |
| The project's own | each `plugins.sources[].path` | listing it under `plugins.enable` |

A plugin is known by the `id` of its manifest, never by its folder name; a folder named otherwise is listed under problems by
`alba plugins list`. A project plugin with the id of a built-in one replaces it only when the project says so under
`plugins.replace`; otherwise the built-in one stays, the project's copy is listed as refused, and enabling that id fails with the
reason. Of two project plugins with one id the first is used and the other refused. `plugins.replace` may name built-in ids only,
each with a project plugin of that id.

```yaml
plugins:
  enable: [image-gateway]
  sources:
    - { path: tools/alba/plugins }   # holds a plugin whose manifest says id: image-gateway
  replace: [image-gateway]           # use the project's image-gateway instead of the built-in one
```

Built in today: `example-echo`, a complete tool (manifest, skill and a
small stdio MCP server in Node) to copy when writing a new one. Third-party sources (`git`, `npm`), the lock file and trust levels
are not implemented yet; such a source is refused.

## Using tools in a project

```yaml
# alba.yaml
plugins:
  enable: [mesh-studio, example-echo]
  sources:
    - { path: tools/alba/plugins }
  by_kind:
    model: [mesh-studio]        # every order of kind "model" uses it
```

An order uses the tools it names and the tools of its kind:

```bash
alba orders add M3 --title "Crate model" --kind model --tools mesh-studio
alba orders set M3 --tools mesh-studio,example-echo     # an empty value clears the list
```

Loading the project fails when an enabled plugin is missing or its manifest is broken (with the file and key), and when `by_kind`
names a tool that is not enabled. Without a `plugins` block nothing is read.

## What a run of the order gets

- **MCP servers.** The tool's servers join the role's servers in the role mount: `-c mcp_servers.<name>.*` for Codex (with
  `enabled_tools` when the manifest lists tools), `--mcp-config` and `--allowedTools mcp__<name>__<tool>` for Claude, the generated
  OpenCode config for OpenCode (which offers all of a server's tools; the run records a warning). Grok mounts none. A tool server never
  replaces a role server of the same name; the start fails instead.
- **Secrets.** Each `env_from` name must be set in Alba's environment, or the start fails naming the variable. The value goes only into
  the worker's environment, never into arguments, files, the prompt or events.
- **The skill.** The tool's skill is mounted with the order's other skills and listed in the prompt with the reason `tool <id>`.
- **Resources.** The tool's resources are added to the project's (a resource the project declares itself wins) and count among the
  resources the order uses, so the tick waits for a free slot and the run holds a lease, like any other resource.
- **The prompt.** A section **Tools of this run** lists each tool: what it is for, its MCP server and allowed tools (or that the engine
  has none), the CLI, its skill and the resources it holds, and that a paid call is quoted first and an order or note wins over the
  tool's skill.
- **The record.** The run records `tools: [id@version]`.

A tool the order names that is not enabled stops the start with the reason (`cannot start now`), before anything is launched.

## Operations: what Alba runs itself

An operation is a call Alba makes without a worker: a person runs it with `alba tools run`, the producer with a `tool-call` action.

```yaml
operations:
  generate:
    description: One concept image from a prompt.
    input:                                  # an object schema, here or as a JSON file of the plugin ("schemas/generate.json")
      type: object
      required: [prompt]
      additionalProperties: false
      properties: { prompt: { type: string, maxLength: 2000 }, size: { enum: [square, wide] } }
    run: { mcp: mesh, tool: mesh_generate, out_arg: out_dir }   # an MCP tool of agent.mcp; out_arg gets the job's output folder
    # run: { cli: [python, "${plugin}/generate.py", "{input}", "{out}"] }   # or a program: {input} is a JSON file, {out} the folder
    quote: { unit: credits, tool: mesh_quote }   # paid: priced by an MCP tool answering { "amount": n } ({ "amount": 60, "unpriced": true } for a ceiling), or { unit, fixed: 2 }
    output: { files: ["*.png"], text: answer.txt }   # the result files (absent: all), and a file for the answer's text
    timeout_minutes: 10
```

A **tool job** (`J1`, `J2`, ... in `_tool-jobs.json`) goes through these steps; each one is an event on the order (`tool:<job>` when it
runs for no order):

1. **Check.** The tool is enabled, the operation exists and the input fits its schema (`type`, `properties`, `required`,
   `additionalProperties: false`, `enum`, `items`, lengths and bounds). A paid operation needs the order it is for, because the quote
   and the spend are kept on the order.
2. **Quote.** A paid operation is priced (the fixed amount, or the quote tool called with the input) and gets a quote on the order
   (`tool <id>/<operation>`), like the ones workers make with `alba credits quote`. Every paid call gets one: a price of 0, or a quote
   tool answering `unpriced: true` (it could not price the call; its amount is a ceiling), makes an unpriced quote that a person
   approves with a cap of their own. Alba approves a quote itself only when `plugins.auto_approve` covers it; otherwise the job waits
   (`waiting-quote`, with the reason Alba did not approve it) until a person runs `alba credits approve <TAG> <C1> --cap N` or rejects
   it. `--quote <C1>` uses a quote approved beforehand instead (a budget for a batch). Before the call the same gate a worker uses
   checks that the quote is approved and has enough left. No plugin, and not the producer, approves a quote.

   `plugins.auto_approve` keeps a running total per unit. `{ credits: 5 }` approves one job's quote up to 5 credits and at most 50
   credits a day (ten jobs' worth); `{ credits: { per_job: 5, per_day: 20, per_project: 200 } }` names the totals: what Alba
   approved by itself in a UTC day, and in the project ever. The totals count what Alba approved, not what was spent, and a quote a
   person approved does not count. Two processes cannot both take the last of a day: the approval is reserved under the state lock.
   Alba never approves an unpriced quote by itself, however high `per_job` is.
3. **Resources.** The tool's resources are leased for the job, held by its process; a full one leaves the job `queued` with the reason.
4. **Call.** Image, audio and file blocks of the answer, the answer's text (`output.text`) and whatever the program writes go to
   `<state_dir>/tool-jobs/<job>/`; the files `output.files` names are the job's result and are listed on its `tool-job-done` event.
5. **Spend.** Once the call is sent, its spend is booked on the quote, whatever happens next, so the ledger never counts less than was
   spent. A call that answered is booked at its price as soon as it answers (before its files are written, so a full disk does not lose
   it). A call whose cost is not known (it timed out, the connection was lost, a program exited with an error, the tool answered an
   error without saying what it spent, or an unpriced call that did not say) is booked as **unknown, at most the quote**: the price,
   or what the quote has left when there is no price, with `unknown: true` on the ledger line and `spentUnknown` on the job. A person
   who knows better corrects it from the tool's own records.

The tick starts a job again (`alba tools resume <job>` in its own process) once its quote is decided or the resource it waited for
may be free, and marks a job failed whose process died while it ran; a paid one is then booked as unknown, at most the quote (once,
even when two ticks see it). A booking that could not be written (the state was busy) stays on the job as `unbooked`, and the tick
books it.

### The producer's `tool-call`

The producer reads the operations, their input schemas and the latest jobs with `producer_read` kind `tools`, and proposes

```json
{"actions":[{"case":"question/ART1","kind":"tool-call","target":"ART1","reason":"Two looks to choose from",
  "tool":{"id":"image-gateway","operation":"generate","input":{"prompt":"..."}}}]}
```

The tool, operation and input are checked when the proposal is made. A `tool-call` is a proposal a person accepts unless a policy
rule says `mode: auto`. Accepted, it makes the job and starts it in its own process; the action records the job id. A paid one then
waits for its quote like any other, so the producer spends nothing a person (or `plugins.auto_approve`) has not allowed.

### What a tool says it spent

A paid operation's MCP answer may carry `spent` (a number, in the quote's unit) in its structured content. Alba books that instead
of the price: a quote for a ceiling, with the real cost booked after. A failed call books the `spent` its answer carries (credits a
service took before it failed, or `0` when it failed before anything paid was asked); without one it is booked as unknown, at most
the quote. More than the quote has left is booked as what is left, with a warning on the job. So a tool should say `spent: 0` when it
fails before it asks the service for anything paid (`image-gateway` does for a bad input, a missing key and a refused request (4xx);
`tripo-3d` does before the generation is submitted).

## Built-in tools

### `image-gateway`: pictures

Any OpenAI-compatible images endpoint: `/v1/images/generations`, and `/v1/images/edits` when reference pictures are given. Workers
get the `image_generate` tool (and a skill with the picture rules); Alba has the paid operation `generate` (prompt, size, quality,
background, n, model, refs, name), which keeps PNG files with their real size in the job folder. It is priced in `images`, one per picture asked (`n`): it needs an order and a quote a person approves, or `plugins.auto_approve: { images: <n> }`. Reference pictures must be .png, .jpg or .webp files.

| Setting | Default | |
|---|---|---|
| `base_url` | `https://api.openai.com` | the endpoint without `/v1` |
| `model` | `gpt-image-1` | when a call names none |
| `key_env` | `OPENAI_API_KEY` | the variable that holds the key; empty for a gateway that needs none |

### `tripo-3d`: 3D models

Tripo Studio with the member account logged in on the machine (no API key), through the MIT package `tripo-studio-plugin`.

- **Workers** get the `tripo` server with 19 `tripo_*` tools (quote, generate, texture, PBR, export, download, the form and task
  tools) and a skill: check the session, quote, gate with `alba credits gate`, follow the form to its submission, never create twice.
- **Alba** has the paid operation `generate-model` (mode `image`, `multiview` or `text`, tier, face limit, texture, format, name). A
  server only Alba uses (`tripo-ops`, `workers: false`) goes through every step:
  1. It prices the model with Tripo's quote. When Tripo cannot price it (its quote says `unknown`), the job asks for the `ceiling`
     setting as an unpriced quote that says why; a person approves it (`plugins.auto_approve` never does).
  2. After the quote is approved, it checks the session (not logged in: the job fails, and nothing is submitted or booked).
  3. It reads the wallet, opens the generation form and waits on the form to its submission.
  4. It waits on the task, exports the model when another format than GLB is asked, and downloads it into the job folder (made an
     allowed output root for this call).
  5. It reads the wallet again and answers the difference as `spent`.
- The plugin never logs in and never submits twice.

| Setting | Default | |
|---|---|---|
| `server` | empty | absolute path of a local Tripo plugin's `mcp/bootstrap.mjs` (the Codex plugin cache has one); empty: the npm package through `npx` |
| `package` | `tripo-studio-plugin@0.3.13` | the npm package when `server` is empty |
| `ceiling` | `60` | credits a quote asks for when Tripo cannot price it |

It holds `tripo-wallet` (2 slots) while it runs.

### `audio-studio`: music and sound effects

Stable Audio 3 on the machine's own GPU through [audio-studio-mcp](https://github.com/kanaworksai-hue/audio-studio-mcp) (installed
once per machine; the model weights are under the Stability AI Community License). Local and free, so no quote and no order needed.

- **Workers** get the `audio` server with `generate_audio`, `edit_audio` (variation, inpaint, continue), `process_audio` (trim, loop,
  fades, peak or LUFS normalize, 48 kHz WAV/OGG/FLAC) and `unload_models`, and a skill (prompt shapes per audio type, lengths,
  candidates by seed, export for the game, provenance). The server lives as long as the run: no agent session keeps its own copy.
- **Alba** has the operations `generate`, `edit` and `process`, with the inputs of those tools. Each job runs the server once
  (`audio-studio-mcp --output-dir <job folder> --call <tool> --input <file>`): the model loads, the files and their `.json` sidecars
  are written into the job folder, the answer (paths, seeds, peaks) is the job's text, and the process exits, freeing the GPU.

| Setting | Default | |
|---|---|---|
| `server` | `audio-studio-mcp` | the program: an absolute path such as `<checkout>/.venv/Scripts/audio-studio-mcp.exe`, or a name on PATH |
| `output_dir` | empty | where a worker's calls write; empty for the server's own folder |

It holds `audio-gpu` (1 slot) while a run or job uses it: one model on the GPU at a time (medium takes about 12 GB while loaded). The
probe is `audio-studio-mcp --check` (the runtime is installed; no model is loaded).

```yaml
# A local images gateway, and the Tripo plugin Codex already has installed
plugins:
  enable: [image-gateway, tripo-3d]
  settings:
    image-gateway: { base_url: "http://127.0.0.1:8000", model: <the gateway's image model>, key_env: "" }
    tripo-3d: { server: "<home>/.codex/plugins/cache/tripo-studio-plugins/tripo-studio-plugin/0.3.13/mcp/bootstrap.mjs", ceiling: 60 }
  auto_approve: { images: { per_job: 2, per_day: 20 }, credits: 0 }   # small picture jobs, 20 pictures a day; every Tripo quote waits for a person
```

## Commands

| Command | What it does |
|---|---|
| `alba plugins` or `alba plugins list [--json]` | the plugins found (built in and the project's), which are enabled, `by_kind`, the built-in engines and game engines, and manifests that cannot be read |
| `alba plugins show <id> [--json]` | one plugin: servers with their tools, environment names, skill, CLI, probe, resources and the kinds that use it |
| `alba plugins doctor [<id>...] [--json]` | on this machine: runs the probe, says which `env_from` names are not set (names only), starts each MCP server, asks for its tools and says which listed tools it does not offer, and looks for the CLI. Without ids: the enabled tools. Exits 1 when a check fails |
| `alba tools [list] [--json]` | the operations of the enabled tools with their input schemas and whether they are paid |
| `alba tools run <tool> <operation> [--order <TAG>] [--input f.json] [--arg key=value]... [--quote <C1>] [--json]` | makes a job and takes it as far as it goes now (done, or waiting for a quote or a resource). `--arg` values that read as JSON are JSON (`n=3`, `flag=true`). Exits 1 when the job fails or is refused |
| `alba tools resume <job>` | goes on with a waiting job |
| `alba tools jobs [--order <TAG>]` / `alba tools show <job>` | the jobs, and one job with its input, output folder, files, answer and error |

## In the console

The **Tools** page (`/p/<project>/tools`) shows every plugin the project can see: whether it is on, its version and origin, its
settings (the project's value or the default), its MCP servers with the tools workers are offered and the names of the environment
variables they read (set or missing where `alba serve` runs; never the value), skill, CLI, probe, resources, operations and the kinds
that use it. It turns a tool on and off, changes an enabled tool's settings, `plugins.by_kind` and `plugins.auto_approve` (with what Alba
approved by itself today and in all), all through the project file with the same checks as loading it (turning a tool off also takes
out its settings and the kinds' references to it). **Check** runs the doctor on the serving machine. Below them are the latest tool
jobs. `plugins.sources` and `plugins.replace` are changed in the file only. The calls are in [010](../console/010-api.md#additions-tool-plugins).

## Not yet

- Routing by the probe: an order with a tool may still be started on a machine without it.
- Checks and viewers (a `.glb` viewer for tripo-3d); running an operation from the console; an operation that waits on a long task
  (`wait:`) beyond its own timeout.
- Tools on roles (`roles.<id>.tools`) and on the order page of the console.
- Third-party sources, `alba-plugins.lock`, `plugins new` and `plugins test`.
