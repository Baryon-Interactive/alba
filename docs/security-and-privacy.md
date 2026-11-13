# Data, security and privacy

Alba has no telemetry, analytics beacon or automatic update check. Project configuration selects a local repository, work-order folder and state directory. SQLite state is the default; the file backend is explicit. Logs, prompts, reports, messages, usage records, approvals, producer conversation and cached facts live in that configured state or work-order directory. Git worktrees live under `dispatch.worktree_parent`. The console stores language, theme and draft UI text in browser local storage. These files can contain confidential code and prompts; exclude them from public repositories and redact them before sharing.

## What leaves the machine

| Destination | Data and trigger |
|---|---|
| A worker engine's configured model service or gateway | Prompt, code, selected skills, tool results, conversation and other content the worker sends while running; its own account and service policy govern handling |
| Remote machines configured by the user | SSH probes, service checks, jobs and responses; configured remote workers additionally receive Git branch history, code, selected skills, order/prompt files and filtered explicit worker settings, and return commits, changed files and final reports. Connections use the user's SSH setup |
| External links in documents | Opening a link contacts that destination through the browser; remotely hosted images may contact their host when rendered |

All other Alba state and processing remain local. A user-configured command or third-party worker is executable code and can itself use the network. Art reference downloads contact only the user-selected HTTPS source when requested. Package installation fetches dependencies from the configured registry; it is a development/setup operation. The demo uses only Node and local Git and contacts no service.

## What a worker can see

Workers run as the Alba OS user, in their assigned worktree. Worktrees do not restrict filesystem or network access. A worker can read any file its OS user can access, including configured prompt/report paths. Use an OS account or container for a stronger boundary.

Alba removes **all inherited `ALBA_*` variables**, case insensitively, before detached worker launch. This includes project/worker/machine selectors, language, producer controls and any Alba control-plane credentials. Variables naming console, service, server or control tokens are also removed. Such tokens are blocked even in explicit launch values. The console key is kept in the server process and in a key file only the Alba OS account can read (see the API document, "Access"); it is never exported to a worker's environment. A worker running as the same OS account can still read that file, like any other file of the account.

The adapter and `launch.env` then set explicit worker values, including `ALBA_PROMPT_FILE` and `ALBA_LAST_FILE` for script workers. Application-only selectors and controls (`ALBA_PROJECT`, `ALBA_WORKERS`, `ALBA_MACHINES`, `ALBA_LANG`, `ALBA_URL`, `ALBA_BROWSER`, `ALBA_PRODUCER_*`, `ALBA_TEST_*`) stay blocked even in explicit values. Other inherited variables, including PATH, OS settings, proxy settings and model-provider credentials, remain available unless the chosen adapter explicitly isolates them. The Claude adapter removes unconfigured provider settings. Finally `launch.env_unset` removes named variables using native OS case rules (case insensitive on Windows, exact case on POSIX); for example `env_unset: [OPENAI_API_KEY, ANTHROPIC_API_KEY]` prevents those credentials reaching a worker. Adapter-required protocol variables can be protected by the adapter. Check its contract before removing them. Do not put literal credentials in YAML; `${VARIABLE}` references resolve at launch.

The same boundary applies to one-shot verification workers and producer model-engine subprocesses. The detached producer host is an Alba control-plane process and retains the settings it needs to operate Alba; it is distinct from the model engine it launches.

For remote workers, only filtered explicit settings are transmitted from the controller. The host worker inherits ordinary settings from its SSH login after the same internal-variable filter, then applies explicit values and removals. Remote Claude uses that login's own configuration. Protect retained host worktrees, repositories and run artifacts like local state; remote specifications may contain explicit worker credentials.

The producer's MCP server receives only explicit Alba language, worker-path and read-only settings, plus Node settings and CODEX_HOME. It does not serialize inherited Alba settings or tokens into its MCP configuration.

See [SECURITY.md](../SECURITY.md) for reporting and console exposure, and [worker adapters](worker-adapters.md) for launch details.
