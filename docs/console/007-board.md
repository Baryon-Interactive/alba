# 007. Board

Uses the terms of documents 001 to 006.

`alba web [--port 4790] --project <alba.yaml>... [--workers <workers.yaml>]` serves the console and the server-rendered board under `/legacy` for one or several projects. The board is plain server-rendered HTML from `node:http`: no framework, no scripts, a meta refresh every 60 seconds. It listens on `127.0.0.1` only (there is no option to change that, and requests whose `Host` header is not `127.0.0.1` or `localhost` are refused), because it has no login.

## It answers three questions

1. **Is there anything for me to do?** The overview starts with **Needs you**: orders waiting for an answer or a click (the question is shown word for word), waiting for review, blocked or failed. Each row carries its action buttons.
2. **Is everything healthy?** **Problems** lists what the tick would report: stalled runs, runs that look finished, a paid balance that is falling, a quota that cannot be read, ready work nobody can take. **Running** shows which worker has each order and how long since it committed or wrote its log. **The next tick would** shows what the tick would start, resume or record. **Workers** shows each worker's state, running count, usage windows as bars with reset times, the balance and its change over the last 24 hours, and one line for free memory (red when it would block starts).
3. **What is the whole story of one order?** The order page: definition and mandate; which row of the stage table matched and why; every run with the last 40 lines of its log; every report; the event timeline with who did each thing (`cli`, `web`, `tick`).

Rules the page follows:

- A block with nothing in it is not shown; with nothing to do the overview says so in one line.
- A count appears only next to a list it counts, and equals the length of that list. The project page shows stage counts; each one links to the list it counts.
- Labels say who is waited for and for what ("waiting for your answer or click"), not a bare status.
- A problem that every project shares (a worker's quota) is shown once.

## Actions

Buttons open a confirmation page (a GET, which changes nothing); the second step is a POST with a per-start token. Actions: queue, hold, release, cancel, approve, rework (with a required note), and **Tick once**, which is a dry run unless the box is ticked. All of them go through `src/service/actions.ts`, the same layer the command line uses, so the same rules apply (`approve` needs the branch merged and runs the accept command) and the same events are written, with `by: web`.

## Pages

- `/legacy/` overview, `/legacy/workers` registry and quota history, `/legacy/p/<project>` order counts per stage (`?stage=` lists one), `/legacy/o/<project>/<TAG>` order, `/legacy/confirm` the second step.

The quota command and the memory query are slow, so the board reads them at most once a minute and keeps a snapshot for 30 seconds; actions refresh it. The board never records quota history itself; ticks do.

The **Hide empty columns** checkbox keeps only lanes containing orders under the current filters. Its state is reflected in the URL as `empty=hide`, so a compact board view can be bookmarked.
