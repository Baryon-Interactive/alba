# 018. Cross-project Overview

The React console at `/` is the read-only control room for every project configured in the server. The project sidebar remains available on this page, and `/p/<project>` opens the focused project overview. `/p/<project>/needs` lists actionable attention items. Use the linked project pages for order and tick actions.

`GET /api/overview/all` joins the per-project overview data and adds cross-project live work, one shared worker/quota list, project resources and leases, recent approvals, 14 UTC calendar days of activity, and next-tick information. The daily data comes from order documents already in the selected state store: approval and rework action times, run end times and outcomes. A per-project merge is one recorded approval. Queue-to-merge time uses the first queue action before approval; metrics without observations are omitted. The endpoint does not run probes, commands, read run logs or scan event history. It uses the current order documents and the server's cached readings and activity; the existing stream and background snapshot refresh make those readings current.

The attention strip has one chip per non-empty kind. Waiting items use amber; problems use red. Shared findings with identical text are represented once and name their affected projects. A single-project chip opens its Needs page; a multi-project chip opens a short list of links. Lists on the dashboard have fixed row caps and a link to the full list. Empty widgets are hidden. Counts are derived from the associated list, and waiting labels name who must act.

The Overview live section includes open runs and orders in monitoring, with worker, elapsed time, step list, last commit age, leases and monitor deadline. Project stage bars link to the project board filtered by `?stage=`. The 14-day throughput plot groups approvals by project and run endings by outcome. Workers that share a quota source share one usage bar. The page may scroll within bounded panels on a 1920×1080 display; narrow layouts stack.

Run receipts are read from the project work-order folder and, when that folder is inside the project root, the matching relative folder in the order's worktree. The most recently modified receipt wins. The same progress data feeds tick diagnostics, project live rows and order summaries. Work-order folders outside the project root are not mapped into a worktree.

The synthetic timing fixture in `test/bench-overview.ts` builds 500 orders and 20,000 SQLite events, warms the server, and records 20 HTTP samples in ignored `.alba/evidence/overview-timing.json`. The timing test requires p95 under 200 ms.

Each project also has a focused overview at `/p/<project>` and `GET /api/p/<project>/overview`; the Needs page is `/p/<project>/needs`. The focused response is a slice of the same cached aggregate used by `/api/overview/all`, with stage bars, queued work reasons, dependency counts, project throughput, usage, workers and recent decisions.

The root test runner runs files sequentially, so CLI and git fixtures do not compete with other suites for their existing subprocess and event deadlines on a busy workstation. Both store modes still run the complete suite.
