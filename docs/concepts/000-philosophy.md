# 000. Philosophy

Alba is a local control room for making a game with several AI coding agents at once. The agents are different tools behind different gateways, with different quota rules. The person running the project is one human (plus possibly a reviewing agent), not a company.

## Rules

1. **Spend as little of the person's attention as possible, give as much value as possible.** Every line the tool prints, every setting, every element on a board has to earn its place. Healthy things take no space; numbers appear only when they change what you do.
2. **Facts in, state out.** Store what happened (runs, reports, decisions). Work out the state from that. State that is edited by hand can contradict the facts; state that is computed cannot.
3. **Ask one concrete question at a time.** A worker that needs a person asks exactly one question. Nothing is guessed from free text.
4. **Know the real limits.** Subscription windows, paid credits, free memory and per-kind caps are real constraints of a game project. The tool reads them before it starts work and says so when one of them is the reason nothing moves.
5. **No surprises with money.** A worker whose subscription window is used up may silently keep working by spending paid credits. The tool treats a falling balance as a problem to report, and can switch such a worker off.
6. **No secrets in files.** Configuration says where a quota is read from, never a key.
7. **Small and local.** State stays in configured local directories, and the optional console binds to loopback. SQLite and file storage share a backend interface.
8. **Dry first.** Anything that decides (tick) can run without acting, and says what it would do.
