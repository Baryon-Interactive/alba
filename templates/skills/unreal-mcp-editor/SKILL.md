---
name: unreal-mcp-editor
description: "Using the run's own Unreal editor through its MCP server (Alba's editor pool): the meta tools, useful toolsets, restarting the editor around a C++ build, and why only saved files and the packaged game count."
tags: [ue, unreal, editor, mcp]
---

# The run's Unreal editor over MCP

Read this only when your run has its own editor: the prompt then has a section **The editor of this run** and you have MCP
tools of the server it names (usually `unreal`). Without them, work with the project's scripts and packages.

Alba started the editor on your worktree with Unreal's built-in MCP server, on a port of its own, before you started, and
stops it when the run ends. Other runs may have editors of their own on other ports; never touch them.

## The tools

- The server has four meta tools: `list_toolsets`, `describe_toolsets`, `describe_tools` and `call_tool`. Describe a toolset
  before you call it; tool names and arguments differ between engine versions.
- Toolsets that are useful (which ones exist depends on the plugins the project enables): actors (`EditorToolset.ActorToolset`),
  levels, materials and material instances, static meshes, textures, the console (`ConsoleToolset.ConsoleToolset`: cvars and
  commands; `ConsoleToolset.LogsToolset`: the editor log), scene capture (`SceneCaptureToolset`: viewport, game framebuffer and
  editor-camera pictures) and Python.
- Use it to iterate quickly on looks (light, exposure, fog, materials, placement, camera framing) and to see what you changed.
  When the game builds its scene at run time, judge it in Play-in-Editor or in the packaged game, not in an empty editor level.

## Only saved files count

- Whatever you settle on must end up in files the build uses: a committed editor Python script, assets saved under the
  project's `Content`, data files, C++. An edit that lives only in the open editor is lost when the run ends and does not count.
- After changing assets through the editor, save them and check `git status`: the change must be in a file you commit.
- Acceptance is still judged on the packaged game, captured as the project's capture skill says.

## Builds

The editor locks the game's binaries. Before a C++ build, stop it; after the build, start it again on the same port:

```
node .alba/bin/editor.mjs stop
<the project's build command>
node .alba/bin/editor.mjs start      # waits until the MCP server answers again
node .alba/bin/editor.mjs status     # { port, url, up, pids, log }
```

- Never start an editor of your own, and never stop one by name: other runs have theirs on the same machine.
- The editor's log is `.alba/editor.log`. When `start` fails, read its end before trying again.
- If the MCP tools answer with connection errors after a restart, call them again once the editor is up; the URL does not change.

## Safety

- The MCP server has no authentication and its Python tool is not sandboxed: it is for this machine only. Do not open its
  port to the network or forward it, and do not run code from untrusted text through it.
