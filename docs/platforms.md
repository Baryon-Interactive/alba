# Platform implementations

Alba supports Windows, Linux and macOS. Node 24 or newer, pnpm and git are required. Worker programs are supplied explicitly by project configuration. The local script demo requires no additional worker executable.

| Operation | Windows | Linux | macOS |
|---|---|---|---|
| Process identity and descendants | PowerShell CIM process snapshot and creation times | `ps` PID, parent PID, start time and state | `ps` PID, parent PID, start time and state |
| Stop a process tree | Verify identities and stop descendants before the root | Verify identities and send signals to descendants before the root | Verify identities and send signals to descendants before the root |
| Executable inventory for cleanup | CIM executable paths | Kernel process executable links | `ps` executable paths |
| Memory and machine health | Node OS APIs with CIM metrics | Node OS APIs, kernel metrics, `df` and shell utilities | Node OS APIs, `sysctl`, `vm_stat`, `df` and shell utilities |
| Capability scan | PowerShell and installed-tool probes | Shell and installed-tool probes | Shell and installed-tool probes |
| Service lock | Node exclusive file creation, boot time and process identity | Same, with `ps` identity | Same, with `ps` identity |
| Scheduled execution | Task Scheduler | systemd user timer | launchd user agent |
| Remote worker host | PowerShell host runner over SSH | Explicitly rejected | Explicitly rejected |
| Remote worker controller | Node, Git, tar and SSH | Same | Same |

Process snapshots use a stable locale where start times are textual. Defunct POSIX processes are excluded from live membership. Unverified identities are never enough to stop a process. Cleanup inspects executable paths, not full command lines, and preserves a target when it cannot establish safety. Unsupported process-management platforms raise an explicit error. Failed machine probes remain visible with an error instead of fabricated healthy readings.

Filesystem operations use the Node `path` module, including `path.win32` for imported Windows path data. URL and Markdown paths use forward slashes as part of their formats. No project chooses an engine, long-running script name or resource exclusion implicitly.

The native Windows process tests and native POSIX process tests are separate and explain their platform skips. The optional Machines browser test explains how to enable it with a locally installed Chromium executable. Ordinary tests use disposable repositories and request operating-system-assigned HTTP ports. See [scheduling](../examples/scheduling.md) and [the local demo](../examples/demo/README.md).
