# Working in the Alba repository

Alba dispatches work orders to coding agents (workers), watches their runs and reviews their delivery.
This file is the map for agents changing Alba itself. Rules for contributors are in
[CONTRIBUTING.md](CONTRIBUTING.md); they apply here in full. Read this map instead of exploring the tree,
and open only the files your task needs.

## Where things are

| Path | What |
|---|---|
| `src/cli/main.ts` | CLI entry (`pnpm alba ...`); subcommands in `src/cli/*.ts`. |
| `src/orders/` | Order model, stages, reports, SQLite store (`sqlite-store.ts`), planned orders. |
| `src/tick/`, `src/serve/` | The scheduling loop (gather, plan, capacity, execute) and the long-running service with its lock and fleet. |
| `src/run/` | Launching a run (`launch.ts` builds the prompt file), worker environment, inbox, hand-over, end reasons, `finish.ts`. |
| `src/workers/` | Worker config, quota; one adapter per engine in `src/workers/adapters/` (contract: [docs/worker-adapters.md](docs/worker-adapters.md)). |
| `src/routing/`, `src/roles/`, `src/skills/` | Choosing a worker for an order, roles, and skills mounted into a run. |
| `src/review/`, `src/check/`, `src/gates/`, `src/verify/` | Acceptance, delivery checks, gates and image verification. |
| `src/machines/` | Remote machines, SSH, capability probes; engine modules in `src/machines/engines/`. |
| `src/producer/` | The producer that drafts and dispatches planned orders. |
| `src/monitor/`, `src/clean/`, `src/resources/` | Live-run monitoring, cleanup and retention, shared-resource leases. |
| `src/lessons/`, `src/ledger/`, `src/evidence/`, `src/credits/`, `src/usage/` | Lessons injected into prompts, decisions, evidence, credits, usage and spend. |
| `src/design/`, `src/library/` | Design library and asset library. |
| `src/api/`, `src/web/` | HTTP API and web server for the console. |
| `src/plugins/`, `src/editors/` | Tool plugins (MCP) and per-run editors. |
| `src/i18n.ts`, `src/i18n-zh.ts` | Message catalogs; Chinese text lives only in translation catalogs. |
| `ui/src/` | Console front end (React): `pages/`, `components/`, `i18n/`, `lib/`. |
| `test/*.test.ts` | Root tests (Node test runner; one file with `node --test test/<name>.test.ts`, quick set with `pnpm test:fast`, everything with `pnpm test`). |
| `docs/` | Contracts by topic; index in [docs/README.md](docs/README.md). Workflow: `docs/workflow/`, workers: `docs/workers/`. |
| `scripts/` | Build, docs/release/changelog checks, license report, ablation. |
| `examples/` | Demo project and opt-in engine examples. |
| `schema/`, `templates/` | Config schemas and templates for projects. |

## Before you finish

- Run the checks for your change type from the matrix in [CONTRIBUTING.md](CONTRIBUTING.md); at least
  `pnpm typecheck` and the test files you touched or that cover the changed code.
- `pnpm check:release` rejects private absolute paths, usernames and untranslated Chinese in tracked files.
- New behaviour needs a test that drives it and asserts its result, plus a CHANGELOG.md entry when it is
  user-visible.
- Do not commit generated builds, `.alba/` state or anything from a real project.
