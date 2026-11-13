# Machines

The machine registry records studio machines and the services they should run. The Machines page shows reachability, free and total memory, free disk, CPU load, uptime, services, and a 24-hour free-memory sparkline.

## Registry

Use [machines.example.yaml](../machines.example.yaml) as a commented example. Resolution order is `ALBA_MACHINES`, then `machines: machines.yaml` in the project file, then `machines.yaml` next to the selected workers file (`--workers`, `ALBA_WORKERS`, or `workers:`). Project paths are relative to the project file; the environment path is relative to the working directory. An absent implicit registry means no machines; an explicitly configured missing file is an error. Unknown keys, duplicate IDs, invalid values and checks fail with their configuration location.

The top-level mapping contains `probe_minutes` (positive minutes, default 5) and `machines` (a list). Every machine requires `id`, `name`, `os` (`windows`, `linux`, `macos`), and `connect`. IDs use lower-case letters, digits, underscores and hyphens, at most 64 characters. `connect` contains exactly `local: true` or `ssh: alias`. SSH aliases use letters, digits, underscores and hyphens and must begin with a letter or digit. Credentials, accounts and key paths belong in the user's SSH config.

Optional fields are `hardware` (`cpu` and `gpu` descriptions, positive numeric `ram_gb`), `roles` (free-form tags, default empty), `role_requirements`, `workspace`, `repos`, `slots` (positive integer, default 1), `min_free_mem_gb` (nonnegative, default 0), `timing_allowed` (boolean, default false), `notes`, and `services` (default empty). Roles, slots and timing permission are informational metadata; worker placement uses an explicit worker `host`.

Each service has a unique `id`, a `check`, and optional `start_hint`. A check contains exactly one of:

| Check | Meaning |
| --- | --- |
| `tcp: 'build-box:8123'` | TCP connection from the alba host; bracket IPv6 addresses. |
| `http: 'http://sim-linux:8080/health'` | HTTP(S) response from the alba host; 2xx or 3xx is up. Redirects are not followed. URLs cannot contain credentials. |
| `process: compile-agent.exe` | Exact executable name on the machine (Windows accepts names with or without `.exe`). No process arguments are collected. |
| `command: [simulation-status, --check]` | Read-only status command on the machine; exit 0 means up. Argv is preserved without interpolation. |

Checks must only read status. Registry authors are responsible for choosing read-only commands. A command's output is discarded. Each service has a 5-second timeout; a failed or timed-out check is down. `start_hint` is advice shown to a person; alba never executes it or starts a service.

## Probes and problems

Every tick starts a background probe of machines whose last reading is at least `probe_minutes` old, including unreachable machines, and reports problems from the stored readings; a tick never waits for a probe, so a slow or unreachable machine cannot stall the board. Machines are probed in parallel, one refresh at a time per state directory. The on-demand CLI overrides this throttle. Local machines are always reachable; unavailable local metrics are separately reported. SSH uses `BatchMode=yes`, `ConnectTimeout=5` and one connection attempt. Each probe uses one remote command, with Windows PowerShell `-NoProfile -NonInteractive` or POSIX `sh` on Linux/macOS. Metric collection requires the OS status tools (Windows CIM; Linux `/proc`, `getconf`, `df`, `ps`, `awk`; macOS `sysctl`, `vm_stat`, `df`, `ps`, `awk`). Health and capability probes require no additional Alba agent.

Windows load is processor utilization divided by 100; Linux/macOS load is the one-minute load average divided by core count, and can exceed 1. Windows reports fixed drives, Linux reports local mounted filesystems, and macOS reports mounted filesystems. Linux available memory includes reclaimable memory; macOS uses free, inactive and speculative pages. Disk and memory sizes use GiB, displayed as GB consistently with other alba pages.

The state store keeps the latest reading and readings from the last 24 hours under machine IDs in `_machines.json` metadata, on both the files and SQLite backends. Reading the CLI list or web page never probes. Probe failures store a fixed diagnostic rather than raw runner errors or process command lines.

A tick creates one combined machine problem for unreachable status, unreadable metrics, memory below `min_free_mem_gb`, or any disk below 10% free. Each down service gets a separate `machine <id>: service <sid> is down (<check>)` problem. Enabled producer rounds turn these into distinct `machine-down` cards and close them on recovery. The trigger is notice-level by default; configure `producer.session.send_triggers`, `wake_triggers`, and `notice_triggers` like other triggers. Round cards follow `producer.round.enabled` and `every_minutes`.

## CLI and page

```sh
alba --project alba.yaml machines
alba --project alba.yaml machines --json
alba --project alba.yaml machines check
alba --project alba.yaml machines check build-box --json
```

The table shows ID, reachable, free memory, disk free percentage per mount, normalized load, services up/total, and last probe age. JSON has `{ project, machines }`; each machine includes its registry fields, nullable `latest`, and `history`. A reading has `id`, `at`, `reachable`, optional metric/error fields, `disks` and `services`. Checking an unknown ID is an error. `GET /api/machines?project=<id>` exposes the same shape to the board.

Open **Machines** in the resources navigation. Each card shows the latest readings, machine roles and hardware, a 24-hour free-memory sparkline, and service statuses with start hints. Missing readings are explicitly shown. Labels are available in English and Chinese, and the page refreshes cached readings every 30 seconds.

## Capability scan and engine modules

After a successful health probe, Alba runs one generic read-only capability command. It refreshes daily, on a forced probe, after a failed scan, and when engine selection changes. The core reads CPU, cores, threads, RAM, OS and GPU information, plus common tools: git, git-lfs, Python, CMake, Ninja, Node, .NET, compilers and Docker. Windows uses CIM and display adapter metadata; Linux uses /proc, nvidia-smi and lspci; macOS uses sysctl and system_profiler. POSIX scans include user bins, virtualenvs and common /opt bins; macOS also includes Homebrew bins.

No engine is selected by default. Set top-level `engine: unreal`, `engine: unity`, or `engine: godot` in alba.yaml, or set `engine` on an individual machine in machines.yaml. A machine selection overrides the project selection. The separate `skills.engine` field filters skill libraries and does not select machine probes. Full project examples are in [examples/engines](../../examples/engines).

Only the selected module runs, as one additional read-only command. An unselected machine returns no `engines` capability field and no engine-specific suggestions. Changing selection hides results from other modules immediately, including while the next scan is pending. Module failures preserve generic information and appear as `engines[id].error`.

The API and machine page use generic capability fields plus `engines: { [id]: { versions, features, unsupported?, error? } }`. The page displays version badges, feature lists, explicit unsupported operations, and translated role reasons. Each role has a name, purpose, and evidence; missing items with a supported installer have an **Install…** button. Missing editors without an automated installer remain instructions rather than offering a placeholder action.

| Module | Windows | Linux | macOS |
| --- | --- | --- | --- |
| unreal | Registry/default Epic install folders; UBA agent; vswhere and standalone MSVC toolsets; Windows SDK | Build.version under home/opt UnrealEngine folders | Build.version under shared Epic Games and Applications folders |
| unity | Unity Hub Editor folder under Program Files | Unity/Hub/Editor under home or opt | Applications/Unity/Hub/Editor |
| godot | PATH godot/godot4 and Program Files or local Programs Godot executables | PATH, opt/godot and user/local bins, using --version | PATH and system/user Godot.app bundles, using --version |

Unreal MSVC, SDK and UBA probes and compile-helper suggestions are Windows-only. Linux/macOS results explicitly describe those limits. The Unreal module suggests packaging when its editor/toolchain is present, and compile-helper when UBA is present. Unity and Godot suggest packaging when their editor is found. These are installation-based suggestions, not proof that a specific project can build.

The generic hardware suggestion is `gpu-qa` (a discrete AMD/NVIDIA card with at least 3 GB, or unknown VRAM). Timing baselines are always assigned manually. Hardware cannot prove a quiet machine or actual build performance. Windows Store application aliases under WindowsApps are excluded from tool detection: the Python alias does not establish an installed interpreter.

Project-specific roles are declared per machine with `role_requirements`. For example, a project's headless simulation role can require a compiler, CMake and Python:

```yaml
role_requirements:
  sim:
    tools: [compiler, cmake, python]
    min_threads: 8
    min_ram_gb: 15
```

Role names are arbitrary lower-case identifiers. `tools` is a nonempty list of names from the capability inventory; `compiler` accepts cl, gcc or clang, and `claude-code` refers to the claude executable. Optional positive integer `min_threads` and nonnegative `min_ram_gb` gate the suggestion. When hardware qualifies, all required tools must be present to suggest the role; otherwise missing tools are listed. Only supported installer items get an Install button. Unknown tool names remain missing instructions without an installer. These requirements suggest machine roles; they do not define order routing roles or automatically dispatch work.

### Adding an engine

Implement `EngineModule` from [engines/types.ts](../../src/machines/engines/types.ts) and register it in [engines/index.ts](../../src/machines/engines/index.ts). Its interface has `id`, `command(os)`, `parse(output, os)`, and `suggest(os, result)`. Commands must finish explicitly and parsers must reject incomplete scans. Keep engine data inside `EngineResult`; use `unsupported` for unavailable platform features. Suggestions return translation keys/variables and optional installer item IDs. Add the ID to project validation as well as the registry, with tests and an examples/engines YAML file.

Optional `installItems`, `installPlan` and `prepareInstall` hooks own engine-specific installation. They return the same generic `InstallPlan` used by core jobs. Common command transport and compression live in [commands.ts](../../src/machines/commands.ts). The three built-in modules live beside the interface; Unreal copying lives in [unreal-install.ts](../../src/machines/engines/unreal-install.ts).

## Adding a machine from the board

**Add a machine** on the Machines page opens a guide:

1. **Machine**: name, id, operating system, and whether it is this computer (`connect: { local: true }`) or another machine reached over SSH.
2. **Prepare it** (SSH only): the commands to run on the new machine, for its OS. On Windows this is one script to paste into an administrator PowerShell: it installs and starts the OpenSSH server (automatic start), opens the firewall, authorizes the key and prints the IP addresses.
   - Windows: install and start the OpenSSH server, then authorize this computer's public key. For an administrator account the key must go in `%ProgramData%\ssh\administrators_authorized_keys` with its permissions fixed; a key in the user folder is ignored for administrators.
   - Linux and macOS: start the SSH server and append the key to `~/.ssh/authorized_keys`.
   - The guide shows the public keys it finds (`~/.ssh/*.pub` only) and inserts the chosen one. Give the machine a fixed address first.
3. **SSH on this computer**: an alias, address, login name and private key file. The guide shows the `Host` block, and can append it to the SSH config of the user running `serve`. It refuses an alias that is already there and keeps a backup of the old file. alba stores only the alias in the registry.
4. **Test**: one non-interactive login (`BatchMode=yes`, 5-second connect timeout).
   - The first contact records the host key (`StrictHostKeyChecking=accept-new`); a changed key still fails.
   - A failure is reported as a cause with a hint: name not resolved, connection refused, no answer, key refused, host key changed, no ssh program, or other. The raw SSH message is never returned.
   - On success the guide runs a health probe and fills in the memory size.
5. **Use and services**: roles, slots, minimum free memory, timing, hardware, notes and service checks.

Saving validates the entry like the rest of the registry and appends it, keeping comments and a backup. If no registry exists yet, it is created next to the workers file (or at `ALBA_MACHINES` / `machines:`). Each card also has **Edit**, **Probe now** and **Remove**; Remove takes the machine out of the registry only.

## Editing a machine

**Edit** on a machine card opens a form with the registry fields: name, operating system, this computer or an SSH alias, hardware, roles, slots, minimum free memory, timing, notes, workspace, repositories and services. Fields `engine` and `role_requirements` can be changed from the command line; `id` cannot be changed, because readings are stored under it: remove the machine and add it again under the new id. Only the fields that differ from the registry are sent, so a field nobody touched is never rewritten. The edited entry is validated like an added one, the whole file like the registry; comments and the layout of the rest of the file are kept and the old file is kept as `machines.yaml.bak-<time>` (the newest 20).

For a machine reached over SSH, the form also shows the `Host` block of its alias in the SSH config of the user running alba (`~/.ssh/config`), with its file and line, and fields for the address: IP or host name, login name and port. When a machine's IP changes, change it there:

- Only the `HostName`, `User` and `Port` lines of that one block change. A line that exists is rewritten in place (its indent, keyword spelling and `=` or space kept); a missing one is added after the `Host` line. An empty port removes the `Port` line (back to 22). Other hosts, comments, `Match` and `Include` lines, `IdentityFile` lines and line endings (CRLF or LF, a byte-order mark) stay byte for byte. Key files are never opened, and key paths are not changed here.
- alba refuses, with the reason, instead of guessing when: the alias has no `Host` block in that file (it may come from an `Include`; alba lists the Include lines and changes only `~/.ssh/config`), the `Host` line also names other aliases (a change would move them too), or a line earlier in the file (the global part or a matching wildcard `Host`) already sets the same option, so SSH would keep using that value.
- The old SSH config is kept as `config.bak-<time>` (the newest 20).

**Preview** shows the registry fields that would change and the block before and after; nothing is written. Both parts are checked before either file is written. After a save that changes the address, the connection, the operating system or this-computer/SSH choice, alba runs the connection test and, when it connects, a health probe and capability scan, and shows the result; other changes are probed in the background.

From the command line:

```sh
alba machines edit gpu-box                                   # the entry and the Host block of its alias
alba machines edit gpu-box ssh.hostname=192.0.2.77 --dry-run
alba machines edit gpu-box ssh.hostname=192.0.2.77 ssh.user=studio
alba machines edit gpu-box name='AMD box' hardware.ram_gb=64 roles=[gpu-qa,package] notes=null
```

Values are read as YAML (`3`, `true`, `[a, b]`, `{ local: true }`); `null` removes an optional field. `hardware.*` and `repos.*` can be changed key by key; other fields are set as a whole. `ssh.hostname`, `ssh.user` and `ssh.port` (`ssh.port=null` removes it) change the alias's address as above, then the connection is tested and the machine probed. `--json` prints the result as JSON. Each write is recorded as a `machines.edited` or `machines.ssh-config` event with the backup path.

API (with `--sign-in`, calls need the console key in `x-alba-token` or a signed-in browser session; see [the API document](../console/010-api.md#access)):

| Call | Does |
| --- | --- |
| `GET /api/machines/guide?project=` | Registry path, SSH config path and public keys (`*.pub` only). |
| `POST /api/machines/ssh-block` | `{ alias, hostname, user, identity_file?, port?, write? }`: returns the `Host` block; with `write: true` appends it. |
| `POST /api/machines/test` | `{ machine: { os, connect } }`: connection category and, when connected, a reading. Nothing is stored. |
| `POST /api/machines/add` | `{ machine, dryRun? }`: validates and appends; then probes the new machine in the background. |
| `GET /api/machines/ssh-host?project=&alias=` | The alias's `Host` block in the SSH config: `{ file, alias, found, block?, line?, address: { hostname?, user?, port? }, shared, includes, problems }`. Only the SSH config is read. |
| `POST /api/machines/edit` | `{ id, set?, ssh?: { hostname?, user?, port? }, dryRun?, test? }`: `set` maps fields to new values (`null` removes); `ssh` changes the alias's address. Answers `{ changed, backup?, ssh?: { before, after, changed, backup? }, connection?, machine? }`; `test: false` skips the connection test. |
| `POST /api/machines/remove` | `{ id }`. |
| `POST /api/machines/check` | `{ id? }`: runs probes and returns the machines. |

## Installing missing tools and tracking jobs

The board first shows an installation plan with exact commands, size/time estimates and licence/privilege notes. Nothing runs until **Start installing** is clicked. CLI equivalents:

```sh
alba machines install build-box git
alba machines install build-box git --apply
alba machines jobs build-box --json
```

Core items are git, cmake, compiler, python, node, opencode and claude-code. Windows uses winget (Clang for the generic compiler; Python and Node use machine scope); Linux uses apt-get or dnf with non-interactive sudo; macOS uses Homebrew, including Apple Silicon and Intel installation prefixes. Worker CLIs use npm as the SSH login user, under its npm prefix on Windows or ~/.local on POSIX. Node/npm must already be installed. Authentication is configured on that machine by a person. A missing package manager or sudo privilege produces a readable error. Tests generate commands without installing software.

Over Windows SSH, winget runs as SYSTEM through a uniquely named scheduled task. Its framework DLL directories are added to PATH, output is streamed, and the task/log are removed in finally. Scripts travel gzip-compressed under the cmd.exe command-line limit. Only that task is removed. Already-installed winget codes count as success.

The selected Unreal module additionally provides MSVC, Windows SDK and engine copy items. See [Unreal installation](../engines/unreal.md). Its engine copy uses the separate copy-unreal lock; package managers use the install lock, so they can run concurrently while two installers cannot. All running jobs remain visible, alongside recent history. Jobs persist status, current step, output tail, commands and runner PID; a dead runner is shown as interrupted. Cancelling stops only that job's local children; an SSH-side installer may finish independently. Completion triggers a fresh probe and capability scan. This mechanism does not allocate gameplay/build resource leases.

| Call | Does |
| --- | --- |
| GET /api/machines/install-plan?project=&id=&item= | Plan with step labels and readable commands; no execution |
| POST /api/machines/install | { id, item }: starts a job and returns 202 |
| GET /api/machines/jobs?project=&id= | All jobs, newest first; optional machine filter |
| POST /api/machines/jobs/cancel | { job }: cancels a job owned by this server |

Writes require the same access as other machine changes (an allowed Origin; with `--sign-in`, the console key or a signed-in session). Machine responses include jobs, capabilities and suggestions. The page polls every five seconds while jobs run, otherwise every thirty seconds.

See [automated tests](../../test/machines.test.ts) for checks and coverage limits.

## Workers on another machine

In the workers file, `host: build-box` names a registry machine reached through its SSH alias. The machine must have a `workspace` absolute folder and a Windows OS. Windows PowerShell 5.1, Node, Git, tar, the worker CLI and its authentication must be available to the SSH login. Paths use forward slashes without spaces, parent traversal or shell characters. Repositories default to `<workspace>/repos/<project-id>.git`; optional `repos` maps project IDs to other bare repository paths. The host workspace, worktrees and bare repositories are dedicated to Alba workers.

Optional worker `tunnel` is a local TCP port. The runner creates an SSH reverse tunnel bound to remote loopback and fills `{tunnel_port}` in launch arguments and environment values. It retries up to twenty ports on forwarding conflicts. For example:

```yaml
workers:
  - id: remote-code
    engine: opencode
    host: build-box
    tunnel: 8000
    launch:
      program: opencode
      args: [run, --file, '{prompt_file}']
      env: { MODEL_BASE_URL: 'http://127.0.0.1:{tunnel_port}' }
```

The runner stages the order, prompt, selected skill files, role configuration, design snapshot and inbox. It pushes the clean local worktree's branch to a host bare repository, checks out a host worktree and launches the worker over SSH. It fetches commits about every three minutes and at exit, fast-forwards only a clean nondivergent local branch, and collects remaining uncommitted files, deletions and the final-message file. Divergent commits are retained as refs; a failed sync is an error, and local edits are preserved. A dirty worktree is refused rather than overwritten. Prompts and launch paths are rewritten to the host copies. Local staging directories are removed on success and failure; host run artifacts remain for inspection. The Windows watcher checks both SSH-session and runner creation identities before ending descendants on disconnect.

**Git LFS.** The host has no LFS server, so the branch is pushed without LFS content. The runner lists the LFS objects of the branch's files (`git lfs ls-files -l`), the host's prepare step names those its bare repository lacks, and the runner copies them from the local LFS store into `<bare>/lfs/objects`, where the host's `git lfs checkout` reads them. Objects missing from the local store too are named in the log. After checkout the host checks the worktree: if any LFS file is still a pointer (or Git LFS is missing on a host whose branch has LFS files), the worker is not started and the run fails with `remote dispatch failed` and the files concerned. The way back works the same: when the runner fetches the branch from the host (every few minutes and at the end), it lists the LFS files of the fetched branch, copies the objects the local store lacks from `<bare>/lfs/objects` on the host (where the worker's commits put them), fast-forwards without smudging and then runs `git lfs checkout`, so the local files are real. An object that is on neither machine is named in the log and its file stays a pointer.

**Windows hosts: windows and the GPU.** A process started over SSH runs in a session without a desktop, so a program that opens a window or a GPU swap chain (a game capture, the editor) fails there with `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`. The runner puts `desktop-run.ps1` next to `run.ps1` and sets `ALBA_DESKTOP_RUN` to it, and the prompt of a run on a Windows host says how to use it: `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ALBA_DESKTOP_RUN" -TimeoutMinutes 30 -- <program> <arguments>`. It registers a one-off scheduled task with an interactive principal for the SSH user, which runs in that user's desktop session, waits for it, prints its output and exits with its exit code; the task and its files are removed afterwards. It needs that user to be logged on to the host's desktop (automatic logon on a dedicated machine); otherwise it says so and exits with 2.

Transfers wait for both archive processes to close, including on failure, before deleting staging files. Shared [tree cleanup](../../src/fs/remove-tree.mjs) retries temporary file locks and repairs read-only permissions without following links. A staging cleanup failure is logged with the retained path and does not replace the worker exit code or an earlier transfer/synchronization error. Worktree fallback cleanup, scratch checkouts, demo directories and fault-injection copies use the same removal policy; explicit clean actions still report deletion failures.

The controller can run on Windows, Linux or macOS using Node, Git, tar and OpenSSH. **Linux and macOS remote worker hosts are explicitly unsupported and rejected before dispatch.** Their health/capability probes, installers and local workers remain supported. The `.mjs` controller and `.ps1` host script are complementary parts of this transport, not interchangeable OS implementations. See [worker adapter boundaries](../worker-adapters.md), the [injected transport test](../../test/remote-workers.test.ts) and [cleanup regressions](../../test/remote-cleanup.test.ts); tests do not connect to a real host. The transport fixture uses native working directories for tar so both GNU tar and bsdtar accept Windows paths.
