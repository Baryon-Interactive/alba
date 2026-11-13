# Lessons: Unreal Engine projects on Windows (Alba pack `unreal`)

Tooling and process lessons from Unreal 5.x projects run by Alba. Tags: `engine`, `build`, `package`, `accept`, `windows`.
Map the project's kinds to them with `lessons.kind_tags` (for example `ue: [engine, build, package]`). The skill
`unreal-headless-pipeline` has the details and the reasons.

## ALBA-UE-01 Build and package only through the project's scripts
- tags: engine, build, package
- rule:
  - Use the project's build and package scripts; never call `Build.bat`, UnrealBuildTool or RunUAT by hand.
  - The scripts set up the toolchain (compiler location, SDK roots, flags); a hand-typed command misses it.
- why: a hand-typed build fails with "no valid Visual C++ toolchain" or builds with other settings than the package.

## ALBA-UE-02 One engine build at a time; UBT exit 10 means wait
- tags: engine, build, package
- rule:
  - Build, cook or package only while this run holds the engine cap slot (the prompt's **Slots this run holds**).
  - UnrealBuildTool exit code 10: another instance holds its mutex. Wait a minute and run the same command again.
  - A missing header from a folder another build recreated: delete the target's `Intermediate/**/Makefile.bin` and build again.
- why: parallel engine jobs fight over memory and intermediate folders; a stale `Makefile.bin` has cost 20 minutes.

## ALBA-UE-03 Rebuild prebuilt libraries before the engine build
- tags: engine, build, package
- rule:
  - A library the game module links (a rules or simulation library built by CMake) is built or updated before UnrealBuildTool runs.
  - After a merge that changed its headers, the old library links the old code: a mismatched game that fails at run time.
  - When the library appears for the first time in a tree, delete the target's `Makefile.bin` files first.
- why: a package after a merge rejected a new data field and could not load a level, because the library was stale.

## ALBA-UE-04 Content comes from committed headless editor scripts
- tags: engine, build
- rule:
  - `UnrealEditor-Cmd.exe <uproject> -run=pythonscript -script=<file> -unattended -nosplash`; commit the script.
  - Add `-AllowCommandletRendering` when the script compiles materials.
  - Print `CONTENT_<step> OK` or `CONTENT_<step> FAILED` per step and check the log for them.
- why: assets must be rebuildable; an edit made only in an open editor is lost.

## ALBA-UE-05 No /Game/... paths from Git Bash
- tags: engine, build, windows
- rule:
  - MSYS rewrites `/Game/Maps/X` into a path under the Git installation (`<Git>/Game/Maps/X`) and the engine says the map does not exist.
  - Launch the engine from Python `subprocess`, or set `MSYS_NO_PATHCONV=1` for that command.
- why: seen on the first day of more than one project.

## ALBA-UE-06 Remove the SDK junction before deleting a worktree by hand
- tags: engine, build, windows, git
- rule:
  - A worktree may hold a junction into a shared toolchain folder. Remove the link alone first: `cmd /c rmdir <junction>`.
  - Never `Remove-Item -Recurse` a worktree in Windows PowerShell 5.1; it can follow the junction.
- why: deleting the shared compiler stops every engine order on the machine.

## ALBA-UE-07 Evidence comes from the packaged build
- tags: engine, accept, package
- rule:
  - Frame rates, automatic playthroughs and acceptance captures come from the package, not from Play-in-Editor or Live Coding.
  - A Shipping build writes no log: have the game write a result file named on its command line and read that.
  - A preview engine feature not run in this project is "not verified" in the report.
- why: editor numbers differ from the package, and a grep of a missing log passes by finding nothing.

## ALBA-UE-08 Materials on instanced meshes need the usage flag
- tags: engine, art
- rule:
  - Set "used with instanced static meshes" on every material used on instanced static meshes.
  - Check the log for `missing usage flag InstancedStaticMeshes`; the game shows the grey default material otherwise.
- why: the only sign is one log line.
