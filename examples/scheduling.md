# Scheduled ticks

Use one scheduler per project state directory. A tick detects an active `alba serve` lock and skips dispatch. CLI exit codes distinguish no action (0), available action (1), project problems (2), and bad configuration (3).

- Windows: run `schedule-windows.ps1` with the checkout and project file paths. It registers a task using the current Node executable and an argument list, without starting it immediately.
- Linux: copy the service and timer into your systemd user unit directory, edit the checkout and project paths, then run `systemctl --user daemon-reload` and `systemctl --user enable --now schedule-linux.timer`. `journalctl --user -u schedule-linux.service` shows results. The example uses the standard `env` command to resolve Node from the service's configured PATH.
- macOS: replace `NODE_EXECUTABLE`, `ALBA_CHECKOUT` and `PROJECT_DIRECTORY` in the plist with values for that machine, save it in your user LaunchAgents directory, and load it using `launchctl bootstrap gui/$(id -u) <plist-file>`. Use a complete executable path because launchd has a minimal PATH. `launchctl print gui/$(id -u)/org.baryon-interactive.alba.tick` shows its state.

The examples contain placeholders or standard OS utility locations, never a developer's home directory. Scheduling is opt-in; installing Alba does not create tasks or services.
