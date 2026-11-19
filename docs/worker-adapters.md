# Worker adapters

`src/workers/adapters/types.ts` defines `WorkerAdapter`. The registry in `index.ts` resolves an engine ID. Unknown engines use a generic launch template and plain report files.

An adapter supplies `id`, `structured`, `nativeResume`, `prepare(args, context)` and `usage(text, cut)` plus optional `finalMessagePrompt(worker, lastFile)` and restricted verifier hooks (`verifierArgs`, `verifierEnvironment`, `verifierServers`). Preparation returns command arguments, an optional `program` override (used when the adapter runs a Node driver such as `codex-app-run.mjs` instead of invoking the engine binary directly), and an environment with explicit removals. The context contains the worker, selected skills, state directory, prompt and report paths, optional worktree `cwd`, optional `inboxHook` script path, optional configured `program`, optional resumed session and whether execution is remote. Adapters own CLI flags, isolated engine configuration and text/JSON encoding conventions. The core owns worktrees, routing, quotas, report validation and state transitions.

The built-in adapters are Codex CLI (`codex-cli`), Codex App Server (`codex-app`), Claude CLI (`claude-cli`), Antigravity CLI (`agy-cli`), OpenCode (`opencode`), Grok CLI (`grok-cli`) and `script`. The script adapter exports `ALBA_PROMPT_FILE` and `ALBA_LAST_FILE` and invokes the configured local command without a shell. See [the executable demo](../examples/demo/README.md).

To add an engine, create an adapter module, register it, add representative protocol fixtures and exercise a real subprocess through launch and report ingestion. Preserve unknown usage when the engine supplies no numbers. Do not infer success from process exit. Session continuation must be explicitly supported. Keep secrets in environment lookups rather than project files.

Shared protocol folds and final-message decoding live in the adapter directory as well. They handle complete JSON lines and partial tails without leaking engine cases into scheduling or accounting callers.

The adapter registry's `index.ts` is also the public interface for shared stream, action, activity, role and accounting protocols. Core dispatch, monitoring and accounting import this entry point instead of engine implementation modules.

Remote transport also lives under the adapter directory. The registry exports `remoteTarget` and `writeRemoteSpec`; the core resolves template values and starts the returned command through its usual process interface. The transport owns SSH, staging, reverse tunnels and Git synchronization. `runRemote(spec, transport)` accepts injected command/process functions for tests. See [remote machine configuration and limits](operations/028-machines.md#workers-on-another-machine).

OpenCode's adapter asks the worker to save its final UTF-8 message, including the report block, to `last_file` when the launch does not already supply that placeholder. Completion reads a fresh final-message file before the printed stream, whose last message can lose lines.

## Process environment

Detached launch removes every inherited `ALBA_*` variable and console/service/server/control token, case insensitively. Ordinary inheritance remains, including PATH, proxy settings and model credentials. The adapter and `launch.env` explicitly supply required worker settings; control-plane tokens and application-only selectors stay blocked even in explicit values. Finally `launch.env_unset` removes named variables using native OS case rules (case insensitive on Windows, exact case on POSIX). The script adapter explicitly supplies and protects `ALBA_PROMPT_FILE` and `ALBA_LAST_FILE`. One-shot verifiers and producer engine subprocesses use the same boundary. Use `${NAME}` references in configured values rather than storing credentials. A worktree is not a permissions sandbox: workers can read files available to their OS user. See [data and privacy](security-and-privacy.md).

Remote specifications include only filtered explicit environment values, never the controller's inherited environment. On the host, the same shared filter removes internal variables from the SSH login's environment before applying those values and `env_unset`. Remote Claude uses its host login's own configuration instead of a controller-local home. Credentials required on the host are configured there or referenced explicitly; remote run artifacts can contain explicit worker settings and must be protected like local prompt/log state.
