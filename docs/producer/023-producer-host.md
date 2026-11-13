# 023. Producer host

The producer host manages cases and policy-gated actions. It runs inside `alba serve`, turns durable order and tick facts into stable cases, and stores cards and policy-gated actions. The separately enabled session manager owns model processes.

## Serve execution

Production `alba serve` keeps HTTP, the event hub and SSE in the main thread. A persistent coordinator worker owns scheduled/event/manual ticks, finish checks, configuration polling, producer heartbeats and the producer session. Tick jobs execute serially; caps, routing and order choice use the existing tick implementation. A second worker handles heavy buffered API/legacy reads and activity scanning with its own state connection, using completed tick readings for aggregate views. Function-valued test probes retain the in-process adapter; isolated fixtures can supply a probes module.

`GET /api/session` includes `eventLoopDelay.p99Ms` and `maxMs` for the current minute. Set `NODE_DEBUG=alba:serve` to log and reset those measurements every minute. Worker failures reject pending requests, and shutdown allows session writes to finish before releasing the serve lock.

## Project configuration

```yaml
producer:
  enabled: true
  rules:
    - id: stalled-reminder
      instruction: "Remind a stalled worker after the second reminder."
      action: nudge
      mode: observe
  budgets:
    turns_per_hour: 20
    review_runs_per_day: 4
    draft_runs_per_day: 2
    usage_per_day: 100000
```

`enabled` defaults to `false`. Rule modes are `off`, `observe` (the default), `propose`, and `auto`. The validated block is hashed into a policy version and that version and hash are copied to every stored action.

## Cases and state

Intake observes ready deliveries, blocked or unanswered runs, repeated commit reminders, loop findings, repeated normalized errors, free slots, and unreadable quota. Cases merge by stable key and close when their source fact clears. Cards contain the trigger, order stage, verification result when available, a bounded summary, and pointers; report and log text is marked untrusted.

Cases, cards, actions, the pause switch, heartbeat and audit lines use the configured state store, so file and SQLite backends have the same behavior. `producer-audit.jsonl` records case and action changes.

## Commands and interfaces

```text
alba producer status [--json]
alba producer cases|actions|would-do [--json]
alba producer pause|resume
alba producer act <CASE> <ACTION> [--note text] [--reason text]
```

The API exposes `GET /api/producer`, `POST /api/producer/actions`, and `POST /api/producer/pause` or `/resume`. The server-rendered board also has `/legacy/producer?project=<id>`. Observe actions are written to the would-do log, propose actions remain stored for a later click, and auto actions run once through existing order services after the case revision is checked. Pause refuses new actions. Serve emits a heartbeat every minute; an enabled producer whose heartbeat is older than ten minutes appears as a tick problem.

## React console page

The console exposes the producer at `/producer?project=<id>` and from the project navigation at `/p/<id>/producer`. The page refreshes its `GET /api/producer` read model every 30 seconds. It shows the enabled and pause state, policy version and rule modes, open cases with their gate results and untrusted-text marker, the latest 50 observe actions, and proposed actions waiting for a person to run or dismiss. Closed cases are behind a toggle. A project overview includes a one-line link with open-case and today’s would-do counts.

The API session object supplies state, model, turns, usage against budget, heartbeat and last error for the session panel.

The producer and its persistent model session are disabled by default; auto rules require explicit configuration.
