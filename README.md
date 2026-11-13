<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/brand/alba-logo-dark.svg">
    <img src="docs/img/brand/alba-logo-light.svg" alt="Alba" width="232">
  </picture>
</p>

# Alba

Alba is a local control room for coordinating coding agents and scripts through work orders, isolated Git worktrees and evidence-based review.

![Alba work-order board with running work, questions, review and merged deliveries](docs/img/board.png)

**Status: pre-1.0 (0.1.0).** Public contracts and migration expectations are documented in [compatibility](docs/compatibility.md).

## Who it is for

For individual developers and small teams coordinating several coding workers, especially game projects with scarce build capacity or model quotas. Workers can be local scripts or explicitly configured agent CLIs. The demo needs no model account.

## Platform support

| Platform | Implementation | Test coverage |
|---|---|---|
| Windows | Process identity/tree cleanup, machine probes, service locks, Task Scheduler | Backend and console tested locally |
| Linux | POSIX process identity/tree cleanup, probes, locks, systemd timer | Backend and console tested on native Linux |
| macOS | POSIX process identity/tree cleanup, probes, locks, launchd | Covered by CI |

Requires Node 24, pnpm 10.34.5 and Git. See [platform details](docs/platforms.md).

## Quick start: five minutes, local scripts only

In a clean Alba checkout:

```sh
pnpm install --frozen-lockfile
pnpm -C ui build
node examples/demo/run.ts
```

Expect a printed disposable demo directory and accepted commit. The demo creates an order, dispatches `examples/demo/worker.mjs` into a worktree, ingests its report, merges and approves its commit, and checks the HTTP console. No model, remote worker, credential or engine is needed.

Copy the printed directory in place of `<demo-directory>`:

```sh
node bin/alba.mjs --project <demo-directory>/project/alba.yaml serve --port 0 --every 0
```

Open the address printed by `serve` (no sign-in on your own machine; `--sign-in` asks for a key, see [Access](docs/console/010-api.md#access)). Select **Alba Demo** to inspect the merged greeting order. Stop with Ctrl+C. The demo lives in the checkout's ignored `.alba/demo` folder; after stopping the service, its printed directory can be deleted. See [the demo guide](examples/demo/README.md).

## Install as a package

A checkout runs the TypeScript sources directly, with nothing to build. Alba can also be installed as an npm package, for example from a tarball made with `npm pack` (or `pnpm pack`) in a checkout:

```sh
npm install --global ./baryon-interactive-alba-0.1.0.tgz    # or: pnpm add <tarball>, npm install <tarball> in a project
alba --help
```

Node does not strip types under `node_modules`, so packing builds the JavaScript first: `prepack` runs `scripts/build.mjs`, which compiles `src/` to `dist/`, copies the helper scripts beside it and builds the console (`ui/dist`) when the console's dependencies are installed (`pnpm install`). `bin/alba.mjs` runs `src/` when it is there and `dist/` otherwise. `pnpm build` runs the same build by hand; a checkout does not need it.

To use Alba with your own repository (any engine, one machine, a Codex or Claude subscription), follow [Adopt Alba in your own project](docs/concepts/033-adopt-alba.md).

## Core concepts

| Concept | Meaning |
|---|---|
| Order | A bounded task with intent, dependencies and acceptance criteria |
| Run | One worker attempt on an order, recorded with process identity and outcome |
| Worker | Configured compute supply: CLI/script, capabilities, quota and launch template |
| Review | A decision based on the report, committed changes and acceptance evidence |
| Gate | A deterministic condition that blocks dispatch or approval when unmet |

A successful worker exit does not approve an order. [Workflow reference](docs/workflow/002-orders-and-stages.md) describes stage inference and report blocks.

## Optional modules

All three modules below are disabled when omitted. Add only the sections you need to `alba.yaml`:

```yaml
producer:
  enabled: true
  session: { enabled: false }
design:
  enabled: true
art:
  dir: art
  format: alba
```

The [producer](docs/producer/023-producer-host.md) stores cases and policy-gated actions; a model session requires separate explicit configuration. The [design library](docs/libraries/027-design-library.md) uses SQLite to track systems, rules, parameters and measured targets. The [art library](docs/libraries/015-art-library.md) reads references and setting cards from the configured folder; picks and credit records have separate opt-in sections. No game engine is selected implicitly; [engine modules](examples/engines/README.md) are optional.

## Documentation

Start at the [documentation index](docs/README.md). See [worker adapters](docs/worker-adapters.md), [library formats](docs/library-formats.md), [HTTP API](docs/console/010-api.md), [scheduling](examples/scheduling.md) and [contributing](CONTRIBUTING.md) for development checks.

## Data and privacy

Alba has **no telemetry**. Configuration selects the repository, work-order folder, state directory and worktree parent. SQLite records, logs, prompts, reports, conversations and approvals stay there; console preferences and drafts use browser local storage.

The following can leave the machine:

- Worker engines send prompts, code and tool results to their configured model services or gateways.
- User-configured remote machines receive SSH probes and configured commands. Remote workers also receive branch history, worktree code, order/prompt files, selected skills and explicit worker settings, and return commits, changed files and reports.
- External document links and remote images contact their destination when opened or rendered; requested art-reference downloads contact their selected HTTPS source.

Other Alba processing and state stay local. User-configured programs control their own network activity; dependency installation contacts the configured package registry. The demo contacts no service. Workers inherit ordinary environment variables, including model credentials, but inherited `ALBA_*` settings and console/service tokens are removed. Explicit adapter protocol values are added; use `launch.env_unset` to restrict other variables. See [security and privacy](docs/security-and-privacy.md) and [private vulnerability reporting](SECURITY.md).

## License

Source code is licensed under [Apache-2.0](LICENSE), copyright Baryon Interactive. **The Alba name and logo are excluded from the license grant**; see [NOTICE](NOTICE). Dependencies retain their [own licenses and notices](docs/third-party-licenses.md).
