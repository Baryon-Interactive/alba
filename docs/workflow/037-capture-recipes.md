# 037. Capture recipes

Uses the terms of [006. Review](006-review.md) and [026. Acceptance pipeline](026-acceptance-pipeline.md).

Worker-reported screenshots only test the files the worker chose to name. When a project declares `capture:` in `alba.yaml`, Alba builds and launches the order's own worktree under a machine-wide lock, captures each named shot into its own folder, runs deterministic screenshot gates on what it captured, writes a contact sheet and a `manifest.json` receipt, and places its captures ahead of the worker's pictures on the review card.

## Configuration

```yaml
capture:
  recipes:
    - name: battle
      kinds: [visual, art]       # the order's effective kind, or tags: [capture]; the first matching recipe wins
      lock: capture              # named machine lock held for build and shots (default capture)
      lock_wait_minutes: 30      # wait budget for acquiring the lock (default 30)
      timeout_minutes: 20        # all shots together, build excluded (default 20)
      build: [python, tools/package.py, --out, "{worktree}/dist"]   # optional, runs first, in the worktree
      build_timeout_minutes: 60  # build deadline (default 60)
      artifact: dist/Game.exe    # optional: must exist after the build and be newer than its start
      size: [1600, 900]          # optional: every shot must match [width, height]
      launch: [powershell, -NoProfile, -ExecutionPolicy, Bypass, -File,
               "{alba_skills}/game-capture-windows/scripts/window_shot.ps1", -Exe, "{worktree}/dist/Game.exe", -Out, "{out}"]
      done: exit                 # exit: the process writes {out} and exits; file: Alba stops it once {out} is written
      baseline: menu             # optional: every other shot must differ from it by min_change
      min_change: 4.0            # mean absolute Rec.709 luminance difference on 0..255 (default 4.0)
      shots:
        - { name: menu, args: [-Wait, "20", -GameArgs, "-windowed"] }
        - { name: day, args: [-Wait, "25", -GameArgs, "-windowed -Time=12"], timeout_seconds: 180 }
        - { name: night, command: [node, tools/night_shot.mjs, "{out}"] }   # command replaces launch for this shot
```

Recipes are tried in list order; the first recipe whose `kinds` includes the order's effective kind (after classification) or whose `tags` intersects the order's tags wins. `alba capture <TAG> --recipe <name>` selects a recipe explicitly.

Validation rules (`validateCapture`):

- Every command (`build`, `launch`, `shots[].command`, and `shots[].args`) is an array of argument strings, never a shell string.
- Recipe names and shot names match `[A-Za-z0-9_-]+` and are unique.
- Each shot's final arguments (`command`, or `launch` followed by `args`) must contain `{out}`.
- `baseline`, when set, must name one of the recipe's `shots`.
- Unknown keys or unknown `{placeholder}` tokens are configuration errors.
- Per-shot `timeout_seconds` defaults to `120` (or the recipe's `timeout_seconds` when given).

## Placeholders

| Placeholder | Value | Allowed in |
|---|---|---|
| `{tag}` | Canonical order tag (`T1`) | `build`, `artifact`, `launch`, `args`, `command` |
| `{worktree}` | Order worktree path | `build`, `artifact`, `launch`, `args`, `command` |
| `{out_dir}` | Output folder of this capture run | `build`, `artifact`, `launch`, `args`, `command` |
| `{revision}` | Worktree `HEAD` commit SHA | `build`, `artifact`, `launch`, `args`, `command` |
| `{alba}` | Alba's own package root directory | `build`, `artifact`, `launch`, `args`, `command` |
| `{alba_skills}` | `{alba}/templates/skills` | `build`, `artifact`, `launch`, `args`, `command` |
| `{shot}` | Shot name (`menu`, `day`) | `launch`, `args`, `command` |
| `{out}` | Output PNG path (`{out_dir}/{shot}.png`) | `launch`, `args`, `command` |

Each shot runs as a fresh child process with `cwd` set to the order's worktree.

## Lock, timeouts and process cleanup

Before starting `build` or any shot, Alba checks that no run of the order is open, the order's worktree exists, and the worktree `HEAD` equals the tip of `refs/heads/<branch>` (and, inside an acceptance trial, the trial's `branch`). Up to 20 uncommitted files in the worktree are recorded in `manifest.json` under `dirty` and emit a warning without failing the run.

Both `build` and `shots` run inside one machine-wide named lock (`lock`, default `capture`) via `src/run/lock-helper.mjs`:

```
node src/run/lock-helper.mjs <lock> --wait-minutes <lock_wait_minutes> -- node src/capture/runner.ts <job.json>
```

The lock folder is `ALBA_LOCK_DIR` (default `<tmpdir>/alba-locks`). When the lock cannot be acquired within `lock_wait_minutes`, the helper exits `75` without starting the runner; inside `trialAcceptance` the step fails with `capture lock "<name>" busy` and marks the trial `retryable: true`.

The runner records its own PID and creation timestamp at startup. For `done: file` (once `{out}` is written) and whenever a build or shot hits its timeout, the runner stops the child process tree (leaves first, creation-time verified through `src/run/kill-tree.ts`). The parent process also enforces a backstop deadline of `build_timeout_minutes + timeout_minutes + lock_wait_minutes + 2` minutes and stops the runner's verified process tree if the runner itself hangs.

## Output and manifest v1

A capture run writes `<shot>.png`, `<shot>.log`, optional `build.log`, `sheet.png` and `manifest.json` into its output folder (`<state_dir>/acceptance/logs-<trial>/capture/` during an acceptance trial, or `<state_dir>/capture/<TAG>-<time>/` from the CLI). File paths inside `manifest.json` are relative to its folder (and `artifact.path` is relative to the worktree):

```json
{
  "version": 1,
  "tag": "T1",
  "recipe": "battle",
  "report": 3,
  "trial": "8a4e2c10-0000-4000-8000-000000000000",
  "branch": "order-t1",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "dirty": [],
  "lock": { "name": "capture", "waited_ms": 120 },
  "build": { "code": 0, "duration_ms": 4200, "log": "build.log" },
  "artifact": { "path": "dist/Game.exe", "mtime": "2026-11-17T06:00:00.000Z", "sha256": "..." },
  "started": "2026-11-17T05:59:55.000Z",
  "ended": "2026-11-17T06:00:28.000Z",
  "status": "passed",
  "reason": "",
  "shots": [
    {
      "name": "day",
      "file": "day.png",
      "status": "ok",
      "reason": "",
      "exit_code": 0,
      "started": "2026-11-17T06:00:01.000Z",
      "duration_ms": 26000,
      "bytes": 184320,
      "sha256": "...",
      "width": 1600,
      "height": 900,
      "mean_luminance": 0.41,
      "luminance_stddev": 0.18,
      "dark_fraction": 0.02
    }
  ],
  "gates": [
    { "name": "identical", "status": "pass", "detail": "Distinct shots: menu, day, night." }
  ],
  "sheet": "sheet.png"
}
```

## Gates and failure reasons

Every decoded shot is checked by `src/capture/gates.ts` using `verify.screenshots` (or its default thresholds when `verify.screenshots: off`). Every gate names the shots it checked or failed:

- `identical` (`fail`): two shots have the same `sha256` or a 16x16 luminance thumbnail mean absolute difference below `duplicate_diff` (`0.015`).
- `blank` (`fail`): luminance standard deviation below `blank_std` (`0.02`), catching solid-colour and near-empty windows.
- `dark` (`warn`): mean luminance below `dark_mean` (`0.12`) or share of pixels below `0.05` above `dark_fraction` (`0.85`).
- `size` (`fail`, when `recipe.size` is set): decoded dimensions differ from `[width, height]`.
- `baseline` (`fail`, when `recipe.baseline` is set): another shot differs from the baseline shot by less than `min_change` on the `0..255` mean absolute luminance scale (`day looks like menu`).
- `luminance` (`fail` / `warn`, when `verify.screenshots.luminance` is set): matches `rule.match` against `<shot>.png` and checks whole-image or `[x, y, w, h]` region mean luminance.
- `motion` (`fail` / `warn`, when `verify.screenshots.motion` is set): pairs `rule.a` and `rule.b` against `<shot>.png` and checks `0..255` mean absolute luminance difference.

Shot and run failure reasons distinguish what went wrong:

- `the program could not start: <error>` — missing executable or spawn error;
- `exited with code <N> before writing the picture` — the game or wrapper exited non-zero without producing `{out}` (for example no window came up);
- `exited without writing the picture` — exited `0` without writing `{out}`;
- `no picture after <N> s (stopped)` — timed out before completing (process tree stopped);
- `not a PNG (<format>)` or `not decodable (<reason>)` — `{out}` is not a valid decodable PNG;
- stale or missing `artifact` (missing after `build`, or `mtime` older than the `build` start time), failed `build`, open run, missing worktree, or worktree `HEAD` off the tip of `refs/heads/<branch>`.

## CLI and review card

```sh
alba capture <TAG> [--recipe name] [--dry-run] [--json]
```

Runs the matched (or named) recipe into `<state_dir>/capture/<TAG>-<time>/`, records a `capture-run` event with the `CaptureSummary`, and prints one line per shot, the gates and the contact sheet path. Exit codes: `0` passed, `1` capture failed, `2` no matching recipe or invalid configuration. `--dry-run` prints the chosen recipe and expanded build/shot commands without acquiring the lock or starting any process.

In the console (`AcceptanceCard`), **Alba's captures** render first (the contact sheet in the full-size image viewer, per-shot status badge, dimensions and failure reason, gates, and short `revision`), followed by the worker's own evidence images under **Worker's pictures (secondary)**. `AcceptanceCard.capture` takes the latest acceptance trial's `capture` step for the current report, or else the latest `capture-run` event for that report.

## Engine sketches (untested templates)

Adapt paths, map names and command-line flags to your project; see [`examples/capture/alba.capture.yaml`](../../examples/capture/alba.capture.yaml) for the tested local fake-game recipe.

### Unreal Engine (`window_shot.ps1` or `HighResShot`)

Using the built-in `game-capture-windows` `PrintWindow` helper (captures the process's own window without stealing desktop focus):

```yaml
capture:
  recipes:
    - name: unreal-client
      kinds: [visual, ue]
      build: [python, tools/stage_win64.py, --out, "{worktree}/Saved/StagedBuilds"]
      artifact: Saved/StagedBuilds/Windows/DemoGame.exe
      size: [1600, 900]
      launch:
        - powershell
        - -NoProfile
        - -ExecutionPolicy
        - Bypass
        - -File
        - "{alba_skills}/game-capture-windows/scripts/window_shot.ps1"
        - -Exe
        - "{worktree}/Saved/StagedBuilds/Windows/DemoGame.exe"
        - -Out
        - "{out}"
      baseline: menu
      shots:
        - { name: menu, args: [-Wait, "25", -GameArgs, "-windowed -ResX=1600 -ResY=900"] }
        - { name: plaza, args: [-Wait, "30", -GameArgs, "/Game/Maps/Plaza -windowed -ResX=1600 -ResY=900"] }
```

Alternatively, drive Unreal's own screenshot command from a project wrapper script (`-ExecCmds="Automation RunTests ...; HighResShot 1600x900; Quit"`) that moves the saved PNG from `Saved/Screenshots/WindowsEditor/` to `{out}`.

### Unity (`ScreenCapture.CaptureScreenshot`)

Add a small command-line reader in the project (for example reading `-albaScene` and `-albaShot`, loading the scene, waiting a fixed frame count, calling `ScreenCapture.CaptureScreenshot(outPath)` and `Application.Quit(0)`):

```yaml
capture:
  recipes:
    - name: unity-player
      kinds: [visual, art]
      build: [Unity, -batchmode, -quit, -projectPath, "{worktree}", -executeMethod, BuildTools.BuildWindowsPlayer]
      artifact: Builds/Demo.exe
      done: exit
      launch: ["{worktree}/Builds/Demo.exe", -screen-width, "1600", -screen-height, "900", -screen-fullscreen, "0", -albaShot, "{out}"]
      baseline: menu
      shots:
        - { name: menu, args: [-albaScene, MainMenu] }
        - { name: arena, args: [-albaScene, ArenaDay] }
```

### Godot (`--shot={out}` script)

Pass user arguments after `--` to a scene or autoload script that parses `--scene=<name>` and `--shot=<file>`, awaits two rendered frames (`await RenderingServer.frame_post_draw`), writes `get_viewport().get_texture().get_image().save_png(shot_path)`, and calls `get_tree().quit(0)`:

```yaml
capture:
  recipes:
    - name: godot-scenes
      kinds: [visual]
      launch: [godot, --path, "{worktree}", --resolution, 1600x900, --windowed, --, "--shot={out}"]
      baseline: menu
      shots:
        - { name: menu, args: ["--scene=res://scenes/menu.tscn"] }
        - { name: forest, args: ["--scene=res://scenes/forest.tscn"] }
```

### Plain binary

Any standalone binary or Node/Python renderer that writes a PNG to `{out}` (or keeps running with `done: file` while Alba stops it once `{out}` is written):

```yaml
capture:
  recipes:
    - name: renderer
      kinds: [visual]
      build: [cmake, --build, "{worktree}/build", --config, Release]
      artifact: build/Release/render_cli.exe
      launch: ["{worktree}/build/Release/render_cli.exe", --output, "{out}", --width, "1600", --height, "900"]
      shots:
        - { name: title, args: [--preset, title] }
        - { name: overview, args: [--preset, overview] }
```
