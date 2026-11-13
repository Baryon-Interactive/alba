# Endpoint reachability validation

Validated on 2026-11-10 after the endpoint detection, background probe cache, and one-shot CLI recovery changes.

| Check | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm -C ui typecheck` | Passed |
| `pnpm ui:build` | Passed |
| `pnpm test` | 753 tests: 752 passed, 0 failed, 0 cancelled, 1 skipped |
| Focused endpoint and probe tests | 12 passed |
| Producer-session regression tests | 21 passed |

The skipped test is the optional installed-Codex effective-tool check. The full suite completed in 1,003.744 seconds. Local validation output is retained in the state folder's `evidence/endpoint-acceptance-*.log`, with exit codes in `evidence/endpoint-acceptance-result.json` (validated before the rename to Alba).

[Endpoint tests](../test/endpoint.test.ts) verify ten status-less Claude retries with synthetic output become `limit: unreachable`, while HTTP 529 stays capacity. Real output, nonzero usage, and a truncated stream prevent status-less inference. Connection-error detection checks the configured URL and ignores quoted tool output. Endpoint reasons expose only host and port, including when configuration contains fixture credentials or a `base_url` override.

A closed loopback port holds both a resume and a new order, leaves run counts unchanged, marks the worker unavailable, and reports one endpoint problem for that worker. A listening loopback server permits a resume with its session and attempt count preserved. Separate CLI processes verify `alba workers`, a dry-run tick, and a real tick all recognize recovery. Probe-held waits create no attempts; actual failed runs still obey retry caps and backoff.

[Probe-cache tests](../test/probes.test.ts) verify background reads return immediately, pending checks are shared, failures have a TTL, and workers and changed endpoints have separate answers. One-shot commands await their initial asynchronous TCP probes; board requests and recurring ticks retain background refreshes.

Presentation was reviewed in the board renderer, run pages, worker reasons, CLI status, producer case text, and English/Chinese catalogs. Tests assert the endpoint status text and Chinese translation. [Worker outcome documentation](workflow/005-run-and-resume.md#when-the-model-endpoint-is-unreachable) describes the distinction and recovery behavior.

The first full validation run exposed a stale-state polling race in the detached producer-session retry test. Retrying deliberately preserves the previous error during startup; the fixture now waits for the new failure timestamp. Its complete test file and the subsequent full suite passed.
