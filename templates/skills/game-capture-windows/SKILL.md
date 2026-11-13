---
name: game-capture-windows
description: "Screenshots and clips of a game on a shared Windows desktop: capture only your own game window (PrintWindow per process) under the capture lock, then check the frames (contact sheet, black frames, flicker, identical files) before citing them."
tags: [capture, evidence, windows]
---

# Game captures on Windows

Several orders may run games on this desktop at once, and a person may be working on it. A capture shows only the window of
the process you started, is taken under the machine's capture lock, and is looked at before it is cited.

The scripts are in `scripts/` next to this file (the prompt lists where your skills are, for example
`.agents/skills/game-capture-windows/scripts/`). Below, `<skill>` stands for that folder.

## Still picture

```
node .alba/bin/lock.mjs capture -- powershell -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/window_shot.ps1 -Exe <game exe> -Out <png> -Wait 25 -GameArgs "<the game's switches>"
```

It starts the game, waits `-Wait` seconds, takes the game's main window with `PrintWindow` (it works when another window covers
it), saves the PNG and stops only the processes it started. Pass the game's switches with `-GameArgs "..."` (not `-Args`). It
sends no keys and no clicks and does not bring the window forward. It exits 1 when nothing was saved (no window, `PrintWindow` failed): do not cite a file after a failed capture.

## Clip

```
node .alba/bin/lock.mjs capture -- powershell -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/window_clip.ps1 -Exe <game exe> -Out <mp4> -Wait 20 -Seconds 8 -Fps 10 -GameArgs "..."
```

`PrintWindow` frames of the game's window, joined into an MP4 with ffmpeg at the rate actually reached (the script prints it).

Never record with ffmpeg `gdigrab`: by window title it records black for a DirectX 12 window, and a desktop region records
whatever window is on top, often another order's game.

## Before you cite a capture

`node <skill>/scripts/frames.mjs` (Node and ffmpeg, no packages):

| Command | What it tells you |
|---|---|
| `sheet <clip.mp4> --out sheet.png --every 10 --tile 3x3` | one picture of every 10th frame; open it instead of guessing what the clip shows |
| `sheet a.png b.png c.png --out sheet.png --tile 3x1` | the pictures side by side |
| `luma <clip or pictures>` | mean luminance (0..1) per frame and the change from the frame before |
| `check <clip> --flicker 0.05 --cuts 40,95` | black frames (luminance below `--black`, default 0.04) and flicker (a jump above `--flicker` between two frames that is not a camera cut you name); exit 1 on either |
| `same <files...>` | files with identical bytes; exit 1 when any are found |

- Open every picture you name, and the contact sheet of every clip, and describe what you see, not what the file name says.
  A picture must show what its name claims (the screen, the language, the moment).
- Two files with the same bytes are one picture; Alba sends a delivery back for it.
- A black or nearly black frame is a failed capture (the window was minimised, covered for a copy from the screen, or not yet
  drawn): wait longer or capture again, do not cite it.
- Flicker outside a camera cut is a defect of the game, not of the capture: report it.
- Make sure the build you capture is newer than your last code change; a stale package shows the old game.
