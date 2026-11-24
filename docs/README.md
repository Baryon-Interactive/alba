# Alba documentation

Start with the [five-minute demo](../examples/demo/README.md), then choose a topic. All references describe implemented contracts.

## Concepts

| Document | Topic |
|---|---|
| [000-philosophy.md](concepts/000-philosophy.md) | 000. Philosophy |
| [001-concepts.md](concepts/001-concepts.md) | 001. Concepts |
| [033-adopt-alba.md](concepts/033-adopt-alba.md) | 033. Adopt Alba in your own project |

## Workflow

| Document | Topic |
|---|---|
| [002-orders-and-stages.md](workflow/002-orders-and-stages.md) | 002. Orders and stages |
| [004-tick.md](workflow/004-tick.md) | 004. Tick |
| [005-run-and-resume.md](workflow/005-run-and-resume.md) | 005. Run and resume |
| [006-review.md](workflow/006-review.md) | 006. Review |
| [039-first-pass-review.md](workflow/039-first-pass-review.md) | 039. First-pass review |
| [008-shadow-run.md](workflow/008-shadow-run.md) | 008. Shadow run |
| [009-checks-and-waiting.md](workflow/009-checks-and-waiting.md) | 009. Checks, reference values, waiting and watching |
| [011-decisions-questions-evidence-clean-credits-lessons.md](workflow/011-decisions-questions-evidence-clean-credits-lessons.md) | Decisions, questions, evidence, clean, credits and lessons |
| [026-acceptance-pipeline.md](workflow/026-acceptance-pipeline.md) | 026. Acceptance pipeline |
| [037-capture-recipes.md](workflow/037-capture-recipes.md) | 037. Capture recipes |
| [038-visual-targets.md](workflow/038-visual-targets.md) | 038. Visual targets, measured rounds and convergence |
| [042-schedules.md](workflow/042-schedules.md) | 042. Recurring order schedules |

## Workers

| Document | Topic |
|---|---|
| [003-workers-and-quota.md](workers/003-workers-and-quota.md) | 003. Workers and quota |
| [012-routing-and-skills.md](workers/012-routing-and-skills.md) | Routing and skills |
| [014-monitor-leases-loops.md](workers/014-monitor-leases-loops.md) | 014. Long jobs, shared resources, loops, hand-over and start receipts |
| [019-live-runs-and-messages.md](workers/019-live-runs-and-messages.md) | 019. Live runs and messages |
| [031-tool-plugins.md](workers/031-tool-plugins.md) | 031. Tool plugins |
| [032-run-editors.md](workers/032-run-editors.md) | 032. An editor for each run |
| [041-live-message-delivery.md](workers/041-live-message-delivery.md) | 041. Live message delivery (`alba say`) |

## Console

| Document | Topic |
|---|---|
| [007-board.md](console/007-board.md) | 007. Board |
| [010-api.md](console/010-api.md) | 010. The JSON interface |
| [016-documents.md](console/016-documents.md) | 016. Project documents |
| [018-overview.md](console/018-overview.md) | 018. Cross-project Overview |
| [020-usage-and-cost.md](console/020-usage-and-cost.md) | 020. Usage and cost |
| [022-project-overview.md](console/022-project-overview.md) | 022. Project overview |
| [040-run-transcript.md](console/040-run-transcript.md) | 040. Run transcript |

## Producer

| Document | Topic |
|---|---|
| [021-producer.md](producer/021-producer.md) | 021. Producer policy and automation |
| [023-producer-host.md](producer/023-producer-host.md) | 023. Producer host |
| [024-producer-session.md](producer/024-producer-session.md) | 024. Producer session |
| [025-producer-direction.md](producer/025-producer-direction.md) | 025. Producer facts, constraints and standing direction |

## Libraries

| Document | Topic |
|---|---|
| [013-editing-and-libraries.md](libraries/013-editing-and-libraries.md) | 013. Editing the configuration, skills of the project, ledgers and lessons |
| [015-art-library.md](libraries/015-art-library.md) | 015. Art library: picks, references and settings, spend, outside usage |
| [017-state-store.md](libraries/017-state-store.md) | 017. State stores |
| [027-design-library.md](libraries/027-design-library.md) | Design library |
| [030-design-intake.md](libraries/030-design-intake.md) | Design document intake |

## Operations

| Document | Topic |
|---|---|
| [028-machines.md](operations/028-machines.md) | Machines |
| [029-nightly-gates.md](operations/029-nightly-gates.md) | Nightly regression gates |
| [034-notifications.md](operations/034-notifications.md) | 034. Notifications from `alba serve` |
| [035-serve-reload.md](operations/035-serve-reload.md) | 035. Reloading `alba serve` onto new code |
| [036-release-packaging.md](operations/036-release-packaging.md) | 036. Release packaging |

## Proposals

Not implemented; for discussion.

- [Plugins and tools](proposals/plugins.md)

## Contracts and development

- [Platforms](platforms.md)
- [Security, data and privacy](security-and-privacy.md)
- [Compatibility](compatibility.md)
- [Library formats](library-formats.md)
- [Worker adapters](worker-adapters.md)
- [Engine modules](../examples/engines/README.md)
- [Scheduling](../examples/scheduling.md)
- [Validation and fault injection](testing.md)
- [Fault injection results](ablation-results.md)
- [Third-party licenses](third-party-licenses.md)
- [Screenshot provenance](img/README.md)
- [Glossary](glossary.md)
- [Brand: logo, colors and type](brand.md)
- [Design boundaries](rejected-concepts.md)

Local links and heading fragments are checked by `pnpm check:docs`. External links are opened only when requested by the reader.
