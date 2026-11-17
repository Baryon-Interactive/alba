# 034. Notifications from `alba serve`

`alba serve` already observes waiting reviews, unanswered questions, unreadable quotas, tripped worker circuit breakers, stalled or silently ended runs, unreachable machines and unexpected restarts, but without notifications those facts stay inside a console tab or log file until someone looks. An optional top-level `notify:` block in `workers.yaml` sends alerts and a daily digest to external channels without blocking the scheduling loop. Without `notify:`, `alba serve` behaves unchanged.

## Why `notify:` lives in the workers file

`notify:` belongs at the top level of [the workers file](../workers/003-workers-and-quota.md#the-workers-file) rather than in each project's `alba.yaml`:

- One `workers.yaml` is shared by every project of an `alba serve` process (`--workers` or `ALBA_WORKERS`).
- It already describes the machine, worker accounts and quota commands, and `alba serve` reloads it live with validation (keeping the previous valid configuration if an edit fails validation).
- Most conditions—unreadable quotas, tripped breakers, unreachable machines or model endpoints, and `alba serve` crashes—are about workers and the host machine; placing `notify:` in project files would duplicate configuration and send the same shared alert once per project.

## Configuration

The workers file holds only environment variable names (`[A-Z_][A-Z0-9_]*`), never URLs, webhook addresses or tokens:

```yaml
notify:
  channels:
    phone: { type: ntfy, url_env: ALBA_NTFY_URL, token_env: ALBA_NTFY_TOKEN }   # token optional
    team:  { type: slack, url_env: ALBA_SLACK_WEBHOOK }
    hook:  { type: webhook, url_env: ALBA_HOOK_URL, token_env: ALBA_HOOK_TOKEN }
    desk:  { type: windows-toast }
  to: [phone, desk]                                   # default channels
  quiet_hours: { from: "23:00", to: "08:00", except: [serve-crashed, machine-down] }   # local time
  digest: { at: "09:00", to: [team] }                 # optional
  triggers:                                           # all on with these defaults when notify: exists
    review-waiting:   { after_minutes: 120 }
    question-waiting: { after_minutes: 30 }
    worker-paused:    { after_minutes: 0 }
    quota-unreadable: { after_minutes: 20 }
    run-stalled:      { after_minutes: 0 }
    machine-down:     { after_minutes: 10 }
    serve-crashed:    {}
```

When `notify:` is present, all seven triggers are enabled with the default thresholds shown above unless overridden. Each entry under `triggers:` also accepts:

- `off: true` to disable that trigger;
- `to: [<channel>, ...]` to override `notify.to` for that trigger;
- `projects: [<project-id>, ...]` to restrict that trigger to named projects.

Validation rejects unknown keys, unknown channel or trigger names, any inline `url`, `token` or `webhook` key holding a value, and environment variable names that do not match `[A-Z_][A-Z0-9_]*`.

A channel whose `url_env` variable is unset in the `alba serve` environment is **not configured**: `alba notify status` lists it as missing, `alba serve` prints one notice when it starts, and `alba serve` continues running normally.

## Triggers and sources

One `Notifier` runs in the main thread of `alba serve` (covering both foreground and multi-project worker-thread modes). It receives every project's `TickResult` ([004](../workflow/004-tick.md)), `serve.notice` publications, and its own 60 s read-only check of order stores for waiting stages and circuit breakers.

| Trigger | Condition key | Default `after_minutes` | Source and clearing rule |
|---|---|---|---|
| `review-waiting` | `review-waiting:<project>:<tag>` | `120` | Order stage is `awaiting-review` ([002](../workflow/002-orders-and-stages.md)) longer than `after_minutes` since the current `ready` report. Clears when the order leaves `awaiting-review`. |
| `question-waiting` | `question-waiting:<project>:<tag>` | `30` | Order stage is `awaiting-user` (a `waiting` report with a question, or an unanswered worker outbox question) longer than `after_minutes`. Clears when answered or moved out of `awaiting-user`. |
| `worker-paused` | `worker-paused:<project>:<worker>` | `0` | `workerTrip` ([the breaker](../workers/003-workers-and-quota.md#when-a-worker-keeps-failing-the-breaker)) returns an active pause for the worker in that project. Clears once the pause window expires or a non-broken run closes the breaker. |
| `quota-unreadable` | `quota-unreadable:<worker>` | `20` | Shared per worker across all projects of the serve: an enabled worker's quota reading is missing or not `ok` continuously past `after_minutes`. The alert includes the reader error (for example `spawnSync quota-gw ENOENT`) and fires once across all projects until a reading succeeds. |
| `run-stalled` | `run-stalled:<project>:<tag>:<kind>` | `0` | Tick problems `stalled`, `looping`, `start-failed`, `lingering` and `silent-end` ([014](../workers/014-monitor-leases-loops.md)), plus immediate `silent-end` `serve.notice` events from the 5 s process check. The message states whether `dispatch.on_stall: continue` already acted. Clears when that problem kind is no longer open for the order. |
| `machine-down` | `machine-down:<machine>` or `machine-down:endpoint:<endpoint>` | `10` | `machine-down` problems ([028](028-machines.md)) and `launch` `"endpoint unreachable"` problems continuously longer than `after_minutes`. Clears once no served project reports the target down. |
| `serve-crashed` | `serve-crashed` | `0` (at start) | Checked once when `alba serve` acquires project state locks. Fires once per serve start (not once per project) when the previous serve recorded `how: "crashed"` in `<state_dir>/serve.exit.json` or left a dead `serve.lock` with no matching exit record (`ended without a word`), naming PID, start time and uptime. |

### How `alba serve` tells a clean stop from a crash or kill

Stopping `alba serve` from the CLI invokes `serve.stop()` before exiting, while background worker shutdown is asynchronous and can leave `serve.lock` behind on a normal stop. To distinguish exit reasons reliably, `alba serve` writes `<state_dir>/serve.exit.json` (`{ pid, started, ended_at, how: "clean" | "crashed", why? }`):

- `clean` is written synchronously at the start of `stop()`.
- `crashed` (with `why`) is written synchronously from `uncaughtExceptionMonitor` (covering uncaught exceptions and unhandled rejections without altering Node's exit behavior) and on unexpected serve-worker failure.
- At the next start, `acquireLock` compares any dead `serve.lock` against `serve.exit.json`: a matching `clean` record is a clean stop; a matching `crashed` record is a crash; a dead lock with no matching record ended without a word (for example `SIGKILL`, Task Manager termination or power loss).

## Channels

Every send runs asynchronously off the tick path with a 10 s per-attempt timeout and up to 3 tries with exponential backoff. Delivery failures print the channel id and HTTP status or scrubbed error message, never a URL, endpoint or token.

- **`webhook`**: `POST` JSON `{ source: "alba", host, trigger, key, project?, tag?, worker?, title, text, since, at, cleared }` to the URL in `url_env`, with `Authorization: Bearer <token>` when `token_env` is set in the environment.
- **`ntfy`**: `POST` the plain-text body to the topic URL in `url_env` with `Title` and `Priority` headers, plus `Authorization: Bearer <token>` when `token_env` is set.
- **`slack`**: `POST` `{ text }` as JSON to the incoming webhook URL in `url_env`.
- **`windows-toast`**: invokes Windows PowerShell 5.1 (`powershell.exe`, never `pwsh`) using the built-in WinRT `Windows.UI.Notifications.ToastNotificationManager` API and PowerShell's own AppUserModelID, with nothing to install. Title and body text are passed in child environment variables (`ALBA_TOAST_TITLE` and `ALBA_TOAST_TEXT`) and appended as XML DOM text nodes, never interpolated into the PowerShell script.

### `windows-toast` limits

- **Windows only**: on Linux and macOS the channel status is `"not available"`.
- **Interactive user session required**: `alba serve` must run in the signed-in user's desktop session. Starting `alba serve` from a `.cmd` in the user's Startup folder qualifies; a Windows service or non-interactive scheduled task in session 0 cannot display desktop toasts.
- **Focus Assist**: Windows Focus Assist / Do Not Disturb suppresses toast banners according to the user's notification settings.
- **No click action**: the toast displays title and text only; clicking it does not open a browser tab.

## State file and deduplication

Notification state lives in `<machine dir>/notify-state.json` (`ALBA_MACHINE_DIR` when set, else `%LOCALAPPDATA%\alba\machine` on Windows, else `$XDG_STATE_HOME/alba/machine` or `~/.local/state/alba/machine`), updated atomically one writer at a time through `notify-state.lock` in the same folder.

Each condition key stores `first_seen`, `notified_at` and `cleared_at`. An open condition sends **once** when its duration passes `after_minutes`, is not sent again while open (including across `alba serve` restarts and live `workers.yaml` reloads), and becomes eligible again only after it has cleared and returned.

## Quiet hours and daily digest

- **Quiet hours** (`quiet_hours: { from: "23:00", to: "08:00", except: [...] }`, 24-hour local time): notifications whose trigger is not listed in `except` are held in `notify-state.json` during the window and delivered as **one summary message** per target channel as soon as quiet hours end. Triggers in `except` are sent immediately.
- **Daily digest** (`digest: { at: "09:00", to: [...] }`, 24-hour local time): sends one message per local day at `at` listing orders awaiting review and unanswered questions with their ages, open conditions, unavailable workers with reasons, and `alba serve` restarts in the last 24 hours.

## Setting environment variables for a `.cmd` launcher

When `alba serve` starts from a `.cmd` file (for example in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), keep webhook URLs and tokens out of any tracked repository file:

1. **User environment variables (recommended on one machine)**: set variables for your Windows account with `setx ALBA_NTFY_URL "<topic-url>"` or through **System Properties -> Environment Variables -> User variables**. Sign out and back in (or start the `.cmd` from a fresh shell after setting them) so the parent `explorer.exe` session passes the new variables to Startup scripts.
2. **Untracked local env script**: source a file kept outside any repository with restricted user ACLs at the top of the launcher `.cmd`:

```bat
@echo off
if exist "%LOCALAPPDATA%\alba\notify-env.cmd" call "%LOCALAPPDATA%\alba\notify-env.cmd"
alba serve --workers "%LOCALAPPDATA%\alba\workers.yaml" --project ...
```

Verify what `alba` sees without printing secret values:

```sh
alba notify status --workers workers.yaml
alba notify test --channel phone --workers workers.yaml
```

## CLI reference

- `alba notify status [--json] [--workers <file>]`: lists each configured channel (`configured`, `not configured` or `not available`, and whether each referenced environment variable is `set` or `missing`, never printing values), open conditions with `since` and `notified_at`, quiet-hours state and held count, and the next scheduled digest.
- `alba notify test [--channel <id>] [--workers <file>]`: sends one test notification to the named channel (or every channel in `notify.channels`), prints `<id>: sent (HTTP 200)` (or `<id>: sent` for toast) or the scrubbed error per channel, and exits `1` if any channel failed.
