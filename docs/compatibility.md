# Compatibility during 0.x

Alba is pre-1.0. Minor 0.x releases may change public contracts. Patch releases preserve valid documented inputs except security fixes, rejection of invalid input or correction of behavior that contradicts the documented contract. Internal TypeScript modules and console DOM/CSS are not public APIs.

| Public contract | Scope |
|---|---|
| `alba.yaml` | Documented project keys, defaults, path resolution and validation |
| `workers.yaml` | Worker supply, launch/environment templates, roles, quotas and adapter IDs |
| Library formats | The `alba` schemas, file naming, path confinement and record provenance |
| Report blocks | Delimiters, JSON fields, validation, status meanings and ingestion |
| HTTP API | Documented routes, request/response fields, errors, action authentication and event stream |
| State directory | Store selection, persisted order/event/state shapes, migration/export and lock ownership |

Mark incompatible changes with **BREAKING** in the current version's CHANGELOG.md entry. Identify the affected contract, old and new behavior and required user action. Provide migration instructions, including backup and verification steps for persisted data. Explicitly state when automated migration is unavailable; never silently reinterpret or discard state. New optional fields and routes are additive if existing valid consumers remain usable.

Before changing a persisted format, test reading/migrating representative data in an isolated copy. Do not use a real project as a test fixture. Run the [change-specific checks](../CONTRIBUTING.md#required-local-validation). `pnpm check:changelog` requires an exact current package version heading; human review verifies the content and migration detail.
