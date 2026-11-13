# Demo screenshots

Every PNG in this directory is captured from the built Alba console backed by `examples/demo` data. There are no real projects, personal paths or usernames. The generator runs the real local worker, ingests its report and approves its committed greeting. It adds six reproducible display fixtures from `examples/demo/showcase.ts`: running work, questions for a person and deliveries waiting for review. These are recorded demo states without live processes. All usage counters and model prices are fictional sample data, supplied by the demo files rather than model calls. The generator then starts a temporary loopback console and headless Chromium.

```sh
pnpm -C ui build
pnpm docs:screenshots
```

Set `ALBA_BROWSER` to a local Chromium executable if detection does not find it. Captures use English, dark theme and a 1440 by 900 viewport. `provenance.json` records the scenario, routes, dimensions and SHA-256 digests. The board uses its Hide empty columns control. The script checks that running, question, review and merged cards are visible. The browser, server, SQLite connections and disposable demo directory are closed and removed when the generator finishes. No image generation or editing service is used.

- `console.png`: cross-project overview with work, decisions, review and populated usage.
- `board.png`: the same demo on the order board; the README's lead image.
