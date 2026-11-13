# Glossary

- Order: a unit of work with a definition, dependencies and acceptance criteria.
- Worker: an execution engine with capabilities, quota and a launch command.
- Worker group: an ordered list of workers with a fallback (the next one takes over when the first cannot start); the layer above the workers.
- Route: sends kinds of work to a worker group, with the capabilities they need. Earlier form: role (which also carried skills, MCP servers and rules).
- Run: one worker attempt on an order in its own worktree.
- Report: the worker's structured delivery, question or failure.
- Stage: a state inferred from runs, reports and recorded decisions.
- Tick: one observation and dispatch pass.
- Lease: a reservation of a configured shared resource.
- Review: the acceptance decision after delivery and checks.
- Evidence: a file, result or recorded observation supporting a claim.
