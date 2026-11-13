# 022. Project overview

`/p/<project>` is the project control room. It uses `GET /api/p/<project>/overview`, a project slice built by the same cached aggregate as `GET /api/overview/all`; `/p/<project>/needs` remains the actionable Needs page.

The page hides empty widgets and keeps live work, stage bars, queued work, dependency blockers, throughput, token usage, workers, and recent decisions within bounded panels. Every stage bar links to the board with `?stage=`. The API performs no probes, commands, log reads, or event scans while serving a request.
