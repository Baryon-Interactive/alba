# 001. Concepts

| Concept | What it is |
|---|---|
| Project | One game, described by a `alba.yaml`: repository, folder of work-order files, state folder, dispatch rules, optional table mapping. |
| Order | One unit of work: `tag`, `title`, `kind`, optional explicit `role`, `heavy` class, `needs` (tags that must be merged first), preferred `worker` text, `mandate`, `branch`, `worktree`. Each order resolves to one role before dispatch. |
| Run | One dispatch of an order to a worker: worker, session, start, end, outcome (`completed`, `failed`, `stalled`, `capacity`, `cancelled`), and the rework note it started with. An order can have many runs: retries, resumes after a drop, a different worker. |
| Report | A worker's structured report: status, one-line summary, at most one question, evidence paths, commits. |
| Action | A person's decision: `queue`, `cancel`, `hold`, `release`, `approve`, `rework` (and `stop`, which holds a running order after stopping its processes). |
| Event | An append-only log line for everything above. |
| State store | The project's orders, events and small side state. Projects use SQLite (`state.sqlite`) with optimistic versions by default; `state.backend: files` explicitly selects the file backend. Data can be imported and exported between the two backends. |
| Stage | Where an order stands, computed from runs, reports and actions (document 002). Never stored. |
| Mandate | Why an order may be done and how far: the person's words, a decision-number range, a spend cap, protected paths. Stored and shown only. |
| Worker | Compute supply: engine, model, route/provider, capabilities, quota, cost and limits, or a session offered as a card. Workers hold no kinds, job preferences or skills selection. `notes` describe supply and never affect routing. |
| Route | Who does a kind of work: kinds, required capabilities and a worker group (an ordered list of workers with a fallback, the layer above the workers). Resolve the order's explicit `role`, then the kind mapping, then the default route; without a match, routing reports `no role`. The earlier form, a role, also carried skills, MCP servers and rules; see [routing](../workers/012-routing-and-skills.md#routing-worker-groups-and-routes). |
| Capability | A supply tag such as `shell`, `vision` or `long-context`. A role requires every listed tag; custom tags are allowed and listed. |
| Quota source | Where a worker's usage windows and balance are read from (document 003). |
| Kind / heavy class | Labels on an order used for limits: `kind` says what sort of work it is (for example `sim` or `build`), `heavy` names a scarce shared resource (for example a core module that only two orders may change at once). |
| Tick | One decision pass over all of the above (document 004). |
| Card | A request to a person to start a worker session by hand, for workers that cannot be started by the tool. |

Runs, reports and actions of one order share an increasing sequence number, so "after" always has one meaning.
