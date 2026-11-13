# 032. An editor for each run

Some orders need a running game editor: a worker places actors, captures the scene or runs console commands through the editor's
MCP server. An **editor pool** gives such a run its own editor, opened on the order's worktree, with the MCP server on a fixed port of
the run's machine and attached to the worker. Alba leases the editor like any shared resource and stops it when the run ends,
whatever the outcome.

## The pool

```yaml
# alba.yaml
resources:
  editor-build: { slots: 3 }
dispatch:
  caps: { ue: 3 }

editors:
  ue-editor:                       # the pool's name; it is also a resource (one slot per port)
    program: "<UE 5.9 install>/Engine/Binaries/Win64/UnrealEditor.exe"
    args:                          # {worktree}: the order's worktree on the run's machine; {port}; {log}: <worktree>/.alba/editor.log
      - "{worktree}/game/MyGame.uproject"
      - "-EnablePlugins=ToolsetRegistry,EditorToolset,SceneCaptureToolset,ConsoleToolset"
      - "-ModelContextProtocolStartServer"
      - "-ModelContextProtocolPort={port}"
      - "-nosplash"
      - "-unattended"
      - "-abslog={log}"
    url: "http://127.0.0.1:{port}/mcp"   # the streamable HTTP MCP endpoint
    mcp_name: unreal               # the worker's name for the server (default unreal)
    ready_minutes: 10              # how long the editor may take until its MCP server answers `initialize` (default 10)
    holds: [editor-build]          # resources an editor holds as well
    cap: ue                        # the kind cap a run with an editor counts against
    skills: [unreal-mcp-editor]    # skills a run with this editor gets (Alba's library or the registry)
    machines:                      # machine ids of the machine registry (a local run: the local machine; a remote run: its host)
      main-pc: { ports: [8101, 8102] }
      gpu-box: { ports: [8201], desktop: true }   # desktop: start it in the logged-on user's session; program: when installed elsewhere
```

- `args` must pass `{port}`, and `url` must contain it. A port belongs to one pool only.
- The pool is declared as the resource `ue-editor` with as many slots as it has ports, unless `resources.ue-editor` is declared
  (for example with a `match` that opts orders in by their files; it may not have more slots than the pool has ports).
- `holds` must be declared resources and `cap` must be a cap under `dispatch.caps`.

### Preparing the worktree first

A new worktree of a C++ project has no compiled game module, and an editor started on it stops at once (Unreal shows "the game
module ... could not be found", which `-unattended` closes by itself). `prepare` runs a command in the worktree, on the run's
machine, before the editor starts:

```yaml
    prepare:
      command: [node, .alba/bin/lock.mjs, ue, --, python, tools/build_ue.py]   # {worktree} may be used; here under the machine's ue lock
      skip_if_newer: { outputs: [game/Binaries/Win64], inputs: [game/Source, game/MyGame.uproject] }
      retry_exit_codes: [10]        # tried again on these exit codes (default none)
      retries: 2                    # default 2
      retry_seconds: 30             # default 30
      timeout_minutes: 60           # default 60
```

- `prepare: [python, tools/build_ue.py]` (a list) is the command alone, with the defaults.
- It is skipped when every `outputs` path exists and is newer than every file under `inputs` (paths in the worktree). Without
  `skip_if_newer` it runs before every start of the editor, also `editor.mjs start` after the worker's own build.
- Its output goes to `.alba/editor-prepare.log`. When it fails (another exit code, or the time is up) the run does not start,
  and the reason names the command, the exit code and the last lines of that log.
- It runs while the run holds the pool's `holds` (for example `editor-build`). A lock that other programs on the machine honour
  too, such as the worktree's `.alba/bin/lock.mjs`, goes into the command, as above.

When an editor stops before its MCP server answers, the reason quotes the last message dialog of its log (or its critical
error), for example `the editor exited before its MCP server answered; it said: "The game module ... could not be found ..."`.

## Which orders get one

An order uses the pool like a resource: `alba orders add|set <TAG> --uses ue-editor`, or by a `match` of `resources.ue-editor`. Other
orders are not affected. A run uses one pool at most.

Such an order holds the pool, the pool's `holds` (here `editor-build`) and a slot of its `cap` (here `ue`, as if the order were
`heavy: ue`), in the tick's plan, in `alba run` and in the prompt's **Slots this run holds**. The pool's resource counts the ports of
all its machines; the tick and `alba run` also count the free ports on the machine of the run's worker. When every port there is
taken the tick waits ("every ue-editor port on main-pc is taken"); a start by hand is refused with who holds them, before anything
is made.

## What a run does

When the run starts, after its worktree is ready and before the worker:

1. Alba takes a free port of the pool on the run's machine (the order's own slot again if it still has one). When that machine has
   none free the start is refused: "every ue-editor port on main-pc is taken".
2. It writes the editor's spec to `<worktree>/.alba/editor.json` and the helper to `<worktree>/.alba/bin/editor.mjs` (both kept out
   of git).
3. The worker command becomes `node .alba/bin/editor.mjs run -- <worker command>`. The helper starts the editor, waits until a
   `POST <url>` with `initialize` answers (every 5 seconds, up to `ready_minutes`), then starts the worker. An editor that exits, never
   appears within 90 seconds or does not answer in time is stopped, the worker is not started, and the run fails with "the run's
   editor did not start, so the worker was not started: ..." and the reason.
4. The worker gets the MCP server: Codex `-c mcp_servers.unreal.url="http://127.0.0.1:8101/mcp"`, Claude `--mcp-config` with
   `{ "type": "http", "url": ... }`, OpenCode a `remote` server. `NO_PROXY`/`no_proxy` gain `127.0.0.1,localhost`, so a proxy set for
   the worker does not take the editor's traffic.
5. The prompt has a section **The editor of this run** with the port, the URL and how to restart the editor, and the run gets the pool's `skills` (Alba's `unreal-mcp-editor` says how to use the editor).
6. The run records `editor: { pool, machine, port, url, log }`; events `editor-slot` and, at the end, `editor-released`.

### Restarting around a C++ build

The editor locks the game's binaries. The worker stops it before a build and starts it again after, on the same port:

```
node .alba/bin/editor.mjs stop
<the build>
node .alba/bin/editor.mjs start      # waits until the MCP server answers
node .alba/bin/editor.mjs status     # { port, url, up, pids, log }
```

### Stopping

An editor is found by its command line: the editor program's file name with this run's `-ModelContextProtocolPort=<port>` (the
argument that holds `{port}`). Nothing else is ever stopped.

- When the worker exits, the helper stops the editor before it exits itself.
- `alba stop` and a stall kill the helper's process tree, which includes the editor the helper started.
- An editor the worker restarted is not a child of the helper; the tick looks at every slot, and for a slot whose run has ended (any
  outcome, a crash of Alba included) it stops the editor by its command line and gives the port back. It first marks the slot
  `releasing` under the state lock: its port stays busy until the editor is stopped, a new start of the same order takes another
  port, and only that slot is removed afterwards (a fresh start of the order no longer loses its slot to the cleanup of the old one).

## Seeing them

`alba status` ends with the editor slots: pool, order, machine, port, up or down. `alba editors list [--json]` shows the same with the
editor's process ids; `alba editors restart <TAG>` and `alba editors stop <TAG>` act on a local slot (events `editor-restarted`,
`editor-stopped`).

## Remote runs

On a remote host the editor runs on the host's copy of the worktree, and the helper is run there with the worker. With `desktop: true`
the helper starts the editor through `$env:ALBA_DESKTOP_RUN`, in the desktop session of the user logged on (an SSH session has none).
The tick stops a leftover editor there with `ssh <host> node <worktree>/.alba/bin/editor.mjs stop`.
