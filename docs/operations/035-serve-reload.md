# 035. Reloading `alba serve` onto new code

Configuration files (`alba.yaml`, `workers.yaml`, `skills.yaml` and dispatch tables) are already reloaded live while `alba serve` runs ([010](../console/010-api.md#alba-serve)). Only changes to Alba's own code require a new process. `alba serve reload` hands the port and project state locks over from the running process to a freshly prepared one without stopping open worker runs or tripping crash alerts.

## Command line and API

```sh
alba serve reload [--project alba.yaml...] [--port N] [--force] [--wait 90]
```

`alba serve reload` reads `serve.lock` in the first project's state folder (`pid` and `port`), reads the console key file for that port (`console-<port>.json`), calls `POST /api/serve/reload`, waits until `<first state_dir>/serve-handover.json` reaches `done` (or fails), and prints the old PID, new PID and measured port-handover gap. It exits `0` on `done` and `1` on a refusal, preparation failure or timeout (`--wait`, default `90` seconds).

`POST /api/serve/reload` accepts `{ "force"?: boolean }` and returns `202` `{ "from": <pid>, "state": "starting" }` once preflight passes and the replacement process has been spawned, or `409` `{ "error": { "code": "conflict", "message": "<reason>" } }` when refused. Unlike general console calls in default no-sign-in mode, this route requires **both** a loopback socket (`127.0.0.1` / `::1`) **and** an explicit credential (`x-alba-token` from the console key file, or a signed-in browser session with an allowed `Origin`); unauthenticated calls in open mode are refused with `401`.

Four `serve.notice` stream events report progress and outcomes: `reload-started`, `reload-refused`, `reload-failed` and `reload-done`.

## Handover steps

1. **Preflight in the old serve.** Before anything is started or closed, the running serve checks whether a reload is already in progress, whether this serve process holds any acceptance or tool resource lease (unless `--force` / `force: true`), and whether the code smoke passes. Any failure refuses the reload immediately (`409` / exit `1`, `reload-refused`) naming what blocked it.
2. **Detached start of the new serve.** The old serve spawns a replacement `alba serve` via `spawnDetachedProgram` with the same `process.execPath`, `process.execArgv`, entry script, arguments (replacing `--port 0` with the actual port), working directory and environment, plus `--takeover <pid>:<started>`. Output appends to the `--log` file when set, otherwise `<first state_dir>/serve.log`.
3. **Preparation without taking locks or the port.** The new serve validates options, loads every project and workers file, preloads its runtime modules, writes `<first state_dir>/serve-handover.json` (`{ from, to, state: "ready" }`) atomically and waits. If anything fails before `ready`, it writes `{ state: "failed", why }` and exits; the old serve stays up and emits `reload-failed`.
4. **Draining the old serve.** Once `ready` appears, the old serve stops starting new ticks, chat turns, design measurements and nightly gates, lets each project thread finish any tick in progress, and waits up to `120` seconds (`--drain-seconds`) for running producer chat turns, measurements and gates to finish. It then writes a `clean` exit record (`serve.exit.json` with `how: "clean", why: "reload"`) in every project's state folder, releases every `serve.lock` and console key file, closes HTTP connections and the listening socket, writes `state: "released"` with `closed_at`, and exits `0`.
5. **Takeover by the new serve.** As soon as `released` is written (or the old PID exits), the waiting serve acquires every `serve.lock` and binds the same loopback port (retrying for up to `60` seconds if the kernel is still releasing the socket), writes `state: "done"` with the measured `gap_ms` between `closed_at` and `listening`, and emits `reload-done`. If a lock or the port cannot be acquired within `60` seconds, it writes `state: "failed"` and exits non-zero so an external supervisor can start a fresh instance.

## What is refused and why

- **Reload already in progress**: a second reload request while preflight, preparation or draining is running is refused so two replacement processes are never started at once.
- **Held acceptance or tool lease** (without `--force`): acceptance trials and tool-plugin jobs record the `alba serve` process PID on their resource leases (`_leases.json` and `machine.sqlite`). Exiting the serve while one is active would cut off the in-process step; `--force` overrides when the operator intends to interrupt it.
- **Failing code smoke**: syntax errors or broken imports in the updated tree are caught before the running serve drains.
- **Uncommitted branch switch or mid-operation git state under `--watch-code`**: switching branches or running an interactive rebase, merge, cherry-pick or revert leaves intermediate files in `src/` that should not be loaded automatically.

## Code smoke

Every manual reload and every `--watch-code` reload runs two child checks in parallel (60-second ceiling, no full `tsc` typecheck):

1. `node <execArgv> <entry> --help` must exit `0` and print the Alba help header, exercising the CLI module graph.
2. A module child strips TypeScript types from `src/serve/worker.ts` and `src/web/read-worker.ts` to catch syntax errors without running top-level worker-thread side effects (`parentPort` / `startCoordinator`), and dynamically imports all of `worker.ts`'s dependencies (`coordinator`, `tick/gather`, `tick/execute`, `run/finish`, `orders/service`, `orders/backend`, `i18n`, `web/snapshot`, `serve/fleet` and `web/server`).

## Automatic reload with `--watch-code`

```sh
alba serve --watch-code --log logs/serve.log --project alba.yaml
```

`--watch-code` records the git branch checked out at startup (`git symbolic-ref --short HEAD`) and watches `src/` recursively. After `10` seconds with no further file change, it reloads automatically if all three checks pass:

- `git symbolic-ref --short HEAD` in the code repository still matches the branch checked out when serve started;
- no merge, rebase, cherry-pick, revert or bisect is in progress (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`);
- preflight (no blocking acceptance/tool lease, and the code smoke passes) succeeds.

If any check fails, `alba serve` emits `reload-refused` with the reason and waits for the next change in `src/`.

## Logging (`--log`) and keep-alive supervisors

`alba serve --log <file>` appends all serve output (startup banner, tick summaries, notices and errors) to `<file>` instead of writing to `stdout`, and passes the same `--log <file>` to every reloaded serve so output stays in one continuous file. Without `--log`, the first serve writes to `stdout` and a reloaded serve appends to `<first state_dir>/serve.log`.

In a launcher script supervised by a local keep-alive loop—one that checks whether the port is listening (sleeping 60 s at a time while it is) and otherwise starts `alba serve`, polls that child every 5 s until it exits, waits 15 s and loops back—reload cooperates cleanly with the supervisor:

1. **First reload (supervisor started the old serve)**: when the old serve exits `0` at step 4, the new serve binds the same port within a second. Within 5 s the supervisor sees the old child has exited, sleeps 15 s, checks the port at the top of the loop, finds the new serve already listening, and switches into passive 60 s watch mode without starting a duplicate.
2. **Later reloads (supervisor is in 60 s watch mode)**: each port check sleeps 60 s. In watch mode a check only sees a free port if it wakes inside the brief handover window (or if takeover exceeded 60 s), and even if the supervisor ever launched a second process after the new serve took over, the duplicate immediately exits on `acquireLock` because the new serve already holds `serve.lock`.
3. **Use `--log` instead of shell `>>` redirection**: shell `>> logs/serve.log 2>&1` binds only the first child of the wrapper script; passing `--log logs/serve.log` directly to `alba serve` lets every reloaded generation append to the same log file.
4. **One last manual restart**: a serve process started from older code before reload support existed does not expose `/api/serve/reload`; restart it once by hand to load the reload-capable version, after which updates use `alba serve reload` or `--watch-code`.

## Runs, producer sessions, acceptance and notifications

- **Open worker runs**: workers are spawned detached through Alba's short-lived starter helper ([005](../workflow/005-run-and-resume.md)), so their processes are outside `alba serve`'s tree. Reload leaves open runs and their state untouched; the new serve picks up monitoring them immediately.
- **Producer sessions**: draining stops new producer passes and waits up to `120` seconds for active director chat turns, design measurements and nightly gates to finish before closing the persistent router session. Any chat turn still marked `running` past the drain deadline is marked interrupted on startup rather than replayed, and wanted sessions resume on the new serve.
- **Clean stop and notifications**: `SIGINT` and `SIGTERM` now wait up to `35` seconds for `serve.stop()` to finish worker shutdown and remove every `serve.lock` before exiting. Both a normal stop and a reload write `how: "clean"` (`why: "reload"` on reload) to `serve.exit.json`, so `serve-crashed` notifications ([034](034-notifications.md)) never fire on a reload or clean stop, and deduplicated notification state in `notify-state.json` carries across unchanged.
