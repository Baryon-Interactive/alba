# Security policy

Only the latest 0.x release receives security fixes. Do not put vulnerabilities, secrets or private project data in public issues.

Use this repository's **Security > Advisories > Report a vulnerability** to open a GitHub private security advisory. Include the affected version, platform, a minimal reproduction, impact and sanitized evidence. Maintainers coordinate investigation, fixes and disclosure inside the advisory.

Alba runs local commands and coding agents with the permissions of its OS account. Configuration and worker executables are trusted code. A worktree is filesystem separation, not an OS sandbox. Run untrusted workers in a separate OS account, container or machine with restricted credentials.

The console binds to loopback and validates Host and Origin. Requests another site makes (`Sec-Fetch-Site: cross-site` or `same-site`) are refused before anything runs, no `GET` changes state, browser writes must carry an allowed Origin, and the console page has a Content-Security-Policy. By default there is no sign-in: any program and browser on this machine may read and change orders through it. On a machine other accounts use, start it with `--sign-in`: each start then makes a console key that no answer ever contains (it lives in the server process, in the sign-in link the command prints, and in a key file only your OS account can read: `%LOCALAPPDATA%\alba\run`, `$XDG_RUNTIME_DIR/alba` or `~/.alba/run`), and every interface call and old-board page, reads included, needs the key (`x-alba-token`, for programs) or a browser session cookie (`HttpOnly; SameSite=Strict`) that `/login` gives for the key. Do not expose the console through a public proxy, and do not share a sign-in link: it is the key.

Limits: without `--sign-in`, other accounts on the same machine can use the console. With it, cookies do not separate ports, so a server another account runs on `127.0.0.1` receives the session cookie if you open its pages in the same browser profile; use another profile (or sign out with `POST /logout`) before you do. Programs running as your own OS account, workers included, can read the key file. The key is not a worker credential and is never put into a worker's environment.

See [data and privacy](docs/security-and-privacy.md) for network boundaries, worker environment inheritance, state contents and redaction guidance.
