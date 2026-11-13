# ui: the web console

A React single-page app for the board. It talks only to the JSON interface under `/api` ([docs/console/010-api.md](../docs/console/010-api.md)); the types come from [`src/api/types.ts`](../src/api/types.ts) and are imported, not copied.

Stack: Vite, React 19, TypeScript (strict), React Router 7 (library mode), TanStack Query, Tailwind v4 with shadcn/ui-style components (Radix, lucide), `@tanstack/react-virtual` and `anser` for logs, `@git-diff-view/react` for diffs, recharts for the quota chart, cmdk for the command palette.

## Commands

```bash
pnpm install               # from the repository root: ui is a workspace package
pnpm -C ui build           # type check, then ui/dist (not committed; the board serves it when it exists)
pnpm -C ui dev             # dev server on :5173, /api, /login, /logout proxied to ALBA_URL (default http://127.0.0.1:4777); with `alba serve --sign-in`, sign in at http://localhost:5173/login?key=<key>
pnpm -C ui dev:mock        # dev server on made-up data (ui/src/mocks), no board needed
pnpm -C ui test            # vitest
node ui/scripts/i18n-keys.mjs   # every text passed to t('...') has a Chinese text in src/i18n/zh.ts
```

## How it works

- **One source of truth.** Pages read with plain `GET /api/...` calls through TanStack Query. The page never builds state from event payloads.
- **Live updates.** `GET /api/stream` (Server-Sent Events) tells the page what changed; `src/lib/events.ts` maps each event name to the queries it makes stale, and only those are read again (events are collected for 150 ms first). After a lost connection everything is read again once. The run log page opens a second stream with `logs=<run key>` for its own lines.
- **Signing in and writes.** By default nothing to sign in to. With `alba serve --sign-in` the page still holds no key: the browser signs in once at `/login` (the link `alba serve` prints) and then sends a session cookie (HttpOnly, SameSite=Strict) with every call; an answer 401 sends the page back to `/login`, which returns to it. Actions go through a confirmation dialog, then a `POST`. The served `index.html` has a Content-Security-Policy: no script from elsewhere, no inline script except those of `index.html` itself (allowed by hash). See "Access" in [docs/console/010-api.md](../docs/console/010-api.md#access).
- **Counts equal lists.** A number next to a block is the length of the list under it (`src/lib/needs.ts`), never a separate server count.
- **Stages are read-only.** The board has no drag and drop: a stage is worked out from facts. The buttons follow the stage too (`visibleActions` in `src/lib/stages.ts`): *approve* only on an order that waits for review, a running order offers *hold* and *cancel*; an order that waits for a click on a card (`waitingFor: card`) has its own block on the first page and no answer box.
- **Cost is never invented.** A cost nobody reported is shown as *unknown*, not `$0.000`; an estimate from a price table is marked (`src/lib/spend.ts`).
- **Review.** The diff tab shows commits, a file list and the patches; a comment on a line is kept in the browser (marked *Draft* until it is sent) and, with a remark, becomes the rework note (`src/lib/rework.ts`, `src/lib/drafts.ts`). Sending the rework clears the draft. The highlighter loads 24 languages instead of all of highlight.js (`src/lib/highlight`, wired in `vite.config.ts`): the review chunk is about a quarter of its former size.
- **Pages for the ledger-style features.** Decisions (searchable, a new one needs its source), options questions (cards with thumbnails, full-size view, an optional note), evidence (grid, full size, compare side by side or with a divider, video), quotes for paid resources (approve with a cap, reject, ledger), lessons (by tag) and the clean plan. The clean page only reads: applying is `alba clean --apply` on the command line, and the page hands over that command after two confirmations.
- **Narrow screens.** At 900 px and below the sidebar is a drawer, the board and tables scroll sideways and the tab list scrolls.
- **Language and theme.** English and Chinese (the English text is the key, as in `src/i18n.ts` of the tool; Chinese words follow `docs/glossary.md`), light and dark; both are stored in `localStorage`.

## The mock server

`ui/mocks/plugin.ts` is a Vite plugin that answers `/api` itself from `ui/src/mocks/data.ts`: a made-up project with orders in every stage, a run log that grows, a diff, a check with reference values, workers with quota. Actions change the mock state and push stream events, so the whole loop (confirm, write, event, refresh) can be tried without a board.
