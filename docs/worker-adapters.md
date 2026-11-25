# Worker adapters

`src/workers/adapters/types.ts` defines `WorkerAdapter`. The registry in `index.ts` resolves an engine ID. Unknown engines use a generic launch template and plain report files.

An adapter supplies `id`, `structured`, `nativeResume`, `prepare(args, context)` and `usage(text, cut)` plus optional `finalMessagePrompt(worker, lastFile)` and restricted verifier hooks (`verifierArgs`, `verifierEnvironment`, `verifierServers`). Preparation returns command arguments, an optional `program` override (used when the adapter runs a Node driver such as `codex-app-run.mjs` instead of invoking the engine binary directly), and an environment with explicit removals. The context contains the worker, selected skills, state directory, prompt and report paths, optional worktree `cwd`, optional `inboxHook` script path, optional configured `program`, optional resumed session and whether execution is remote. Adapters own CLI flags, isolated engine configuration and text/JSON encoding conventions. The core owns worktrees, routing, quotas, report validation and state transitions.

The built-in adapters are Codex CLI (`codex-cli`), Codex App Server (`codex-app`), Claude CLI (`claude-cli`), Antigravity CLI (`agy-cli`), OpenCode (`opencode`), Grok CLI (`grok-cli`) and `script`. The script adapter exports `ALBA_PROMPT_FILE` and `ALBA_LAST_FILE` and invokes the configured local command without a shell. See [the executable demo](../examples/demo/README.md).

To add an engine, create an adapter module, register it, add representative protocol fixtures and exercise a real subprocess through launch and report ingestion. Preserve unknown usage when the engine supplies no numbers. Do not infer success from process exit. Session continuation must be explicitly supported. Keep secrets in environment lookups rather than project files.

Shared protocol folds and final-message decoding live in the adapter directory as well. They handle complete JSON lines and partial tails without leaking engine cases into scheduling or accounting callers.

The adapter registry's `index.ts` is also the public interface for shared stream, action, activity, role and accounting protocols. Core dispatch, monitoring and accounting import this entry point instead of engine implementation modules.

Remote transport also lives under the adapter directory. The registry exports `remoteTarget` and `writeRemoteSpec`; the core resolves template values and starts the returned command through its usual process interface. The transport owns SSH, staging, reverse tunnels and Git synchronization. `runRemote(spec, transport)` accepts injected command/process functions for tests. See [remote machine configuration and limits](operations/028-machines.md#workers-on-another-machine).

OpenCode's adapter asks the worker to save its final UTF-8 message, including the report block, to `last_file` when the launch does not already supply that placeholder. Completion reads a fresh final-message file before the printed stream, whose last message can lose lines.

## Read-only launches

Planning and split phases ([044](workflow/044-phases.md), [045](workflow/045-split-and-integrate.md)), first-pass review ([039](workflow/039-first-pass-review.md)), consult ([043](workers/043-consult.md)) and independent checks ([026](workflow/026-acceptance-pipeline.md)) choose only workers whose adapter has `verifierArgs`, a launch template and no `card_only`. `verifierArgs(worker, cwd, prompt, lastFile, mcpServers, resume, stateDir)` returns the arguments of a launch in which the engine itself refuses edits, commands and web access; the worker's own `launch.args` are never used. An adapter with `verifierLocalOnly` needs files on this machine, so its workers on an SSH `host` do not qualify. Each feature compares the checked worktree before and after the run as described in its document.

| Engine | Read-only launch |
|---|---|
| `codex-cli`, `codex-app` | `codex exec` with the read-only sandbox, approvals `never`, apps and plugins off and every configured MCP server disabled. |
| `claude-cli` | `claude -p` with only Read, Glob and Grep, an empty strict MCP configuration and an isolated configuration folder. |
| `agy-cli` | `agy` with a custom agent and session settings of Alba's own (below). Local workers only. |

### Antigravity (`agy-cli`)

agy has no command-line option for a tool list or MCP servers, so each read-only launch writes a custom agent with a random name, `<state_dir>/agy-read-only/.agents/agents/alba-read-only-<random>.md`, and runs:

```text
agy --output-format stream-json --agent alba-read-only-<random> --settings <state_dir>/agy-read-only/agy-settings.json
    --disable-slash-commands --print-timeout 8h [--model <model>] --add-dir <state_dir>/agy-read-only [--conversation <id>] -p <prompt>
```

in the checked worktree. agy finds custom agents in folders added with `--add-dir` as well as in the folder it runs in, so nothing is written into the worktree or into the person's agy configuration.

- The agent lists `tools: ["read_file"]` (agy 1.5's file reader, which also reads images and PDFs), `inheritMcp: false`, `inheritCustomizations: false` (no rules, skills, hooks or subagents of the person or of the worktree) and `commandExecutionPolicy: "off"`.
- agy 1.5 has no other read-only built-in tool: `list_dir`, `grep_search` and `find_by_name` are deprecated and have no effect. The agent therefore gets one MCP server, `alba-read` (`src/workers/adapters/agy-read-mcp.mjs`, run with Node), with two tools: `list_files` (files under a folder, Git's view for a work tree, optional glob) and `search_text` (a JavaScript regular expression, line by line, skipping binary files and files over 2 MiB and stopping after 30 seconds with a note). It accepts only absolute paths inside the worktree it was started for, never follows symbolic links and writes nothing.
- The session settings (used for this run only; agy never saves them) set the default agent mode with `request-review`, allow `read_file(*)`, `mcp(alba-read/list_files)` and `mcp(alba-read/search_text)`, and deny `command(*)`, `write_file(*)`, `read_url(*)`, `execute_url(*)`, `download_url(*)` and `unsandboxed(*)`. Deny rules win over the person's own allow rules, headless agy refuses whatever would ask for approval, and `--dangerously-skip-permissions` is never passed.
- The name is random because agy prefers a same-named agent inside the checked worktree to one in an added folder; a worktree cannot know a name chosen at launch. Agent files older than seven days are removed at the next launch.
- agy writes no final-message file; Alba reads the final message and usage from the stream-json log as for ordinary agy runs. agy caches the `alba-read` tool schemas under `~/.gemini/antigravity-cli/mcp/alba-read/`.

The model comes from the worker entry (`model`, else `launch.model`). To plan or review on another model than the worker's usual one, add a second worker entry for the same agy program with that model and point the role at it, as in [044](workflow/044-phases.md#choosing-the-planning-model).

## Process environment

Detached launch removes every inherited `ALBA_*` variable and console/service/server/control token, case insensitively. Ordinary inheritance remains, including PATH, proxy settings and model credentials. The adapter and `launch.env` explicitly supply required worker settings; control-plane tokens and application-only selectors stay blocked even in explicit values. Finally `launch.env_unset` removes named variables using native OS case rules (case insensitive on Windows, exact case on POSIX). The script adapter explicitly supplies and protects `ALBA_PROMPT_FILE` and `ALBA_LAST_FILE`. One-shot verifiers and producer engine subprocesses use the same boundary. Use `${NAME}` references in configured values rather than storing credentials. A worktree is not a permissions sandbox: workers can read files available to their OS user. See [data and privacy](security-and-privacy.md).

Remote specifications include only filtered explicit environment values, never the controller's inherited environment. On the host, the same shared filter removes internal variables from the SSH login's environment before applying those values and `env_unset`. Remote Claude uses its host login's own configuration instead of a controller-local home. Credentials required on the host are configured there or referenced explicitly; remote run artifacts can contain explicit worker settings and must be protected like local prompt/log state.
