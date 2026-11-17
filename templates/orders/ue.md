# Order template: Unreal Engine (`ue`)

## Acceptance

- Build and package scripts exit 0, and packaged autoplay of the changed screen or flow exits 0.
- Every changed screen or state is reached from the real game entry point and verified in its capture.

## Evidence

- artifacts/{tag_lower}/*.png: named captures of each changed screen from the packaged build
- artifacts/{tag_lower}/autoplay.log: result log written by the packaged autoplay run

## Paths

- allow: Source/**
- allow: Content/**
- allow: Config/**
- allow: tools/**
- tool-dir: ~/.codex/generated_images (image-gen)

## Standing rules

- Run at most one engine build or package job on the machine at a time, only while this run holds the engine slot.
- Keep game logic in C++ and rebuildable editor scripts; never commit `Intermediate/`, `Saved/`, `DerivedDataCache/` or packaged output.
- Capture only the window of the packaged process started by this run, never Play-in-Editor or the desktop.
