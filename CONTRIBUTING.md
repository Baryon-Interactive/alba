# Contributing to Alba

Use Node 24, pnpm 10.34.5 and Git on Windows, Linux or macOS. Clone the repository and run `pnpm install --frozen-lockfile`. The local [demo](examples/demo/README.md) needs no account. `pnpm ui:dev` starts the console development server; `pnpm ui:build` builds the console served by Alba.

## Required local validation

| Change type | Local validation |
|---|---|
| Documentation only | `pnpm check:docs`, `pnpm check:release`, `pnpm check:changelog`; regenerate screenshots if changed |
| Behavior, dependencies or CI | Root and UI typecheck and tests; UI build; all three check commands; `pnpm install --frozen-lockfile`; regenerate license report for dependency changes |
| Interface | Root and UI typecheck and tests; UI build; all three check commands; inspect the affected pages, narrow layouts, empty/error states and both languages |
| Worker adapter or engine module | Behavior checks above, protocol fixtures and real subprocess integration; demo; verify environment filtering, report ingestion and relevant native platform probes |
| Platform-related code | Behavior checks above plus affected native platform tests; Windows/Linux/macOS CI; record unavailable native acceptance explicitly |

```sh
pnpm typecheck
pnpm test
pnpm -C ui typecheck
pnpm -C ui test
pnpm -C ui build
pnpm check:docs
pnpm check:release
pnpm check:changelog
```

Skip only the specific assertion that does not apply to the platform, with a reason; never skip an entire file. Diagnose or isolate flaky or very slow tests; do not delete them or add retries. Before deleting a test, name the remaining test that covers its behavior. Run `pnpm test:ablation` before deleting or merging tests and review every surviving mutation. See [fault injection](docs/testing.md).

## Implementation conventions

Use English for source, comments, docs and fixtures; Chinese belongs only in translation catalogs. Store UTF-8 without BOM and LF endings. Keep public contracts explicit, reject invalid input, preserve unknown metrics and isolate project-specific rules in configuration. Tests use disposable state and repositories, assigned ports and local scripts; never use a real project's saves, credentials or running workers.

Add a worker adapter under `src/workers/adapters`, register it in `index.ts` and follow the [adapter contract](docs/worker-adapters.md). Keep engine flags, stream formats, usage and resume behavior in that adapter. Exercise launch through a real subprocess and require a valid report before review.

Machine engine modules implement `src/machines/engines/types.ts` and register in `src/machines/engines/index.ts`. Supply detection, capability and optional install behavior with fixtures for supported platforms. Provide an opt-in example under `examples/engines`; a project with no selected engine must have no engine field in its UI or API. These modules differ from worker CLI adapters.

## Commits and review

Use a short imperative English subject, for example `Filter internal settings from worker environments`. Keep each commit focused; explain behavior and validation in the PR. Include regression coverage for behavior fixes. Follow [compatibility rules](docs/compatibility.md), label breaking changes and provide migration instructions in CHANGELOG.md. Avoid generated builds, state, large files, personal paths and credentials. Contributions are licensed under Apache-2.0; the Alba name and logo are excluded. Follow [the code of conduct](CODE_OF_CONDUCT.md) and [private security reporting](SECURITY.md).
