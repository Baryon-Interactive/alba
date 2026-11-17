# Lessons: coding workers on a shared Windows machine (Alba pack `windows-workers`)

From Codex and Claude workers run by Alba on Windows desktops the owner also uses. The core worker rules
(`alba-worker-rules`) already cover the worktree, commits, long commands, stopping only your own processes, captures and the
report; these lessons add what is specific to Windows and to shared desktops. Lessons tagged `all` go into every prompt.

## ALBA-WIN-01 Write non-ASCII text with a file tool, never through a pipe
- tags: all, windows
- priority: must
- rule:
  - Windows PowerShell 5.1 turns every non-ASCII character passed to a native program (argument, stdin, `@'...'@ | python -`) into `?`.
  - Write such files with the editing tool, a UTF-8 `.py` file, or `Set-Content -Encoding utf8`.
  - Before committing, search the changed files for runs of `???` or U+FFFD.
- why: reports and data files were silently destroyed this way, and the worker's own report did not notice.

## ALBA-WIN-02 Use absolute paths, and read a scripted edit back
- tags: all, git
- rule:
  - The shell's current folder may be another worktree: build and test with absolute paths or an explicit `cd` first.
  - After changing a file with sed or a replace script, read it back; a replacement that matched nothing gives no error.
- why: an experiment ran on the wrong tree, and a no-op replacement went unnoticed.

## ALBA-WIN-03 No desktop automation
- tags: all, windows
- priority: must
- rule:
  - Never use computer use, UI automation or simulated keys and mouse on the desktop; a person works on this machine.
  - Verify input through command-line switches, input injection inside the game, or automated tests; otherwise say "not verified".
  - Capturing your own game window with the capture skill's scripts is allowed and expected: it sends no input.
- why: a worker once took over the person's desktop to test key presses.

## ALBA-WIN-04 Scripts for Windows PowerShell 5.1
- tags: windows
- rule:
  - There may be no PowerShell 7: no PS7-only syntax or APIs; give `Get-Content` and `Set-Content` `-Encoding UTF8`.
  - Judge success by the process exit code; wrap collections in `@()`. Prefer Python or Node for anything non-trivial.
  - Commands shown to a person are written for PowerShell (`& "<folder>\Game.exe"`; a quoted path alone is only printed).
- why: PS7-only calls broke candidate builds.

## ALBA-WIN-05 A failed network call may be the proxy
- tags: all
- rule:
  - Node's `fetch` ignores the proxy variables, and a worker's shell may have none set. Check the proxy before reporting a site as down.
  - Local servers (`127.0.0.1`, `localhost`) must be in `NO_PROXY`.
- why: several "site down" reports were proxy settings.

## ALBA-WIN-06 Tests and automatic runs never write to the real profile
- tags: all
- rule:
  - Anything a test or automatic run writes (saves, settings, logs) goes to a folder named on its command line, never a path built from a runtime "test mode" flag.
  - Assert at the start that the folder is not under the user's real save or profile folders; exit if it is.
- why: a test turned its "automated" flag off to look like a person, and the save path it then built overwrote a game in progress.
