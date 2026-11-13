---
name: unreal-headless-pipeline
description: "Building, packaging and making content for an Unreal Engine project without a person at the editor: the project's build scripts, one engine build at a time, content from committed headless editor Python, prebuilt libraries, worktree clean-up, and what counts as evidence."
tags: [ue, unreal, build, package]
---

# Unreal without a person at the editor

Work orders on an Unreal project build, package and make content from scripts. The editor is a tool a script runs, not a
place where work is done by hand. These rules come from Unreal 5.x projects run by Alba on Windows.

## Build and package through the project's scripts

- Use the project's own build and package scripts (its skill or README names them). Do not call `Build.bat`,
  UnrealBuildTool or RunUAT by hand: the scripts set up the toolchain (compiler location, SDK roots, flags such as `-NoUBA`
  or `-MaxParallelActions`), and a hand-typed command fails with "no valid Visual C++ toolchain" or builds something else.
- Start a build, cook or package in the background with its output in a log file, and wait for it. Do not stop a quiet
  UnrealBuildTool or RunUAT, and do not edit tracked files while it runs.
- Only one engine build, cook or package runs on a machine at a time. Build only if the prompt's **Slots this run holds**
  gives you the engine cap slot. When UnrealBuildTool exits with code 10 (another instance holds its mutex), wait a minute
  and run the same command again; do not delete its files.
- When UBT reports a missing header from a folder another build recreated, delete the target's
  `Intermediate/**/Makefile.bin` and build again: UBT caches include paths and library lists in it.

## Prebuilt libraries the game links

- When the game module links a library the project builds separately (a rules or simulation library, a CMake target), build
  or update that library before UnrealBuildTool runs, every time. A fresh worktree has none (the link fails with unresolved
  externals), and after a merge that changed the library's headers the old one links the old code into the game: a
  mismatched build that fails at run time, not at link time.
- When the library appears for the first time in a tree, delete the target's `Makefile.bin` files: UBT decided what to link
  when it wrote them and does not notice a library that appears later.
- If the project's build script does not do this, do it by hand before the engine build, and say so in your report.
- Acceptance after a merge uses a clean build (or the script's clean option): many unrelated crashes after a merge usually
  mean old object files against a new header layout.

## Content from headless editor Python

- `UnrealEditor-Cmd.exe <project.uproject> -run=pythonscript -script=<file.py> -unattended -nosplash` builds content in
  seconds with no window. Commit the script: assets must be rebuildable from it. An edit that lives only in an open editor is
  lost.
- Add `-AllowCommandletRendering` when the script compiles materials ("this editor has no renderer" otherwise).
- Wrap each step in `try`/`except` and print `CONTENT_<step> OK` or `CONTENT_<step> FAILED <reason>`, so one failed step does
  not hide the others; check the log for those lines.
- Materials used on instanced static meshes need "used with instanced static meshes"; the only sign of a missing flag is a
  log line `missing usage flag InstancedStaticMeshes` and a grey default material.

## Shells and paths on Windows

- Never pass `/Game/...` paths from Git Bash: MSYS rewrites them into paths under the Git installation (`<Git>/Game/...`) and the engine says the
  map does not exist. Launch the engine from Python `subprocess`, or set `MSYS_NO_PATHCONV=1` for that command.
- A worktree may contain a junction into a shared toolchain folder (an AutoSDK link). Before deleting such a folder by hand,
  remove the junction alone (`cmd /c rmdir <junction>`); never `Remove-Item -Recurse` a worktree in Windows PowerShell 5.1,
  which can follow the junction and delete the shared compiler for every order on the machine.

## What counts as evidence

- Frame rates, automatic playthroughs and acceptance captures come from the packaged build, not from Play-in-Editor.
- A Shipping build writes no log: a check that greps one passes by finding nothing. Have the game write a marker or result
  file named on its command line, and read that.
- Live Coding is not evidence that the build works; build with the project's script.
- A preview engine feature you have not run in this project is "not verified" in the report, however well documented.
- A package you hand over is the exact package you checked: give its path and a hash. Repackaging means checking again.
