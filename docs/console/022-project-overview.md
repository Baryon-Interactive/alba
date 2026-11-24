# 022. Project overview

`/p/<project>` is the project control room. It uses `GET /api/p/<project>/overview`, a project slice built by the same cached aggregate as `GET /api/overview/all`; `/p/<project>/needs` remains the actionable Needs page.

The page hides empty widgets and keeps live work, stage bars, queued work, dependency blockers, throughput, token usage, workers, and recent decisions within bounded panels. Every stage bar links to the board with `?stage=`. The API performs no probes, commands, log reads, or event scans while serving a request.

## Order attention

A new dot marks a stage that needs attention, an unanswered worker question, or a run ending since the order was last read. The Board badge and browser title show the project's unread count. Use **Unread only** to filter the board or **Mark all read** to acknowledge its full project. Reading an order or run acknowledges its current attention point while the tab is visible, the window has focus and you have clicked, scrolled or pressed a key within the past minute. Read state is shared across browsers.

The order menu on a card or order page can mute its alerts. Muted orders still count as unread. The bell in the header offers browser notifications and an optional short tone. Both start off. Alerts apply to new attention points received during the session. Clicking a notification opens its order.

Use **Answer** beside a question to reply. On a running or monitoring card, **Peek** opens live activity, the last 200 log lines, a message box and a link to the full run. The preview refreshes every five seconds until closed.

The run glyph spins for active work. After ten quiet minutes, a pause means the process is alive and a dashed amber ring means its presence cannot be verified. A red cross means the process probe found it gone. Hover over the glyph for the activity age and reason. These indicators only describe observations.
