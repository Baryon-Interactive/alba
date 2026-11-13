# Lessons: pictures, 3D models and Blender (Alba pack `art-pipeline`)

For orders that make pictures or models with paid services. Tags: `art`, `image`, `tripo`, `blender`. They go with Alba's
built-in tools `image-gateway` and `tripo-3d` (see docs/workers/031-tool-plugins.md).

## ALBA-ART-01 Images only through the project's image tool, inside the cap
- tags: art, image
- rule:
  - Generate or edit pictures only through the tool the project names (the `image-gateway` tool, or the project's script); never another image API, SDK or skill.
  - Stay inside the order's call cap; without one, at most 3 calls per target picture. Read an error before retrying.
  - If the tool is unavailable, stop the picture part, commit the rest and say so. Never switch to another tool.
- why: one route, no keys in the repository, every call logged and counted.

## ALBA-ART-02 The image model keeps neither your size nor your scale
- tags: art, image
- rule:
  - A returned picture can be smaller than requested, especially with reference pictures: check and record the real size; an upscale is not native.
  - Prompts do not hold on-screen scale ("unit 160 px" comes out about twice as large): check sizes in a composite or in the engine.
  - Non-ASCII prompts go in a UTF-8 file. Look at pictures shrunk to 1024 px on the long side, and at details as 100% crops.
- why: measured on several projects.

## ALBA-ART-03 Paid 3D steps one at a time, inside the cap
- tags: art, tripo
- rule:
  - One paid step at a time; read the balance before and after, and stop when the cap cannot cover the remaining pieces.
  - Every paid step needs an approved quote first. When the service cannot price a step, quote the highest cost seen per step. When a submission's outcome is unknown, look for the task it may have made before submitting again.
  - A refusal that looks like an expired login is often a rejected parameter (texture tier, face count): work up from settings that worked.
- why: identical-looking steps cost 0, 0 and 100 credits, and a resubmission is paid twice.

## ALBA-ART-04 Choose model settings by comparison, the input by silhouette
- tags: art, tripo
- rule:
  - Pick model version, tier and face count by comparing two or three settings on the same input; copy the fields of an accepted order.
  - Complex silhouettes (rider and mount, many legs) go in as one approved picture, not an invented three-view.
  - A piece to be rigged needs a clear T or A pose; long robes and capes stretch into spikes.
- why: each of these cost a full extra round.

## ALBA-ART-05 Blender runs headless from committed scripts
- tags: art, blender
- rule:
  - Run Blender headless with the executable the environment names (e.g. `TRIPO_BLENDER_EXECUTABLE`); no hard-coded paths, no installs.
  - Every clean-up, level-of-detail, export and preview step is a committed script that runs again on new pieces.
  - Report real triangle counts per level of detail.
- why: a hand edit outside a script is lost at the next export, and new pieces need the same pipeline in minutes.

## ALBA-ART-06 Judge pieces as the game shows them
- tags: art, blender, engine
- rule:
  - Review renders use near-game shading and the game's camera distance, not default materials and close-ups.
  - Compare hue and brightness of a piece in the engine under the game's light with the review picture, side by side.
  - Give each piece type a target height relative to one reference figure, and check a line-up picture.
- why: a batch looked dark bronze in Blender and bright gold in the game; sizes with only a maximum came out a quarter as tall.

## ALBA-ART-07 Record provenance for every picture and model
- tags: art, image, tripo
- rule:
  - Per file: tool, model, prompt file, time, cost, task id and a hash of the source picture; keep totals next to the cap.
  - Count calls from the tool's own ledger, not from a count you keep by hand.
- why: rights and contest rules ask for the origin of every asset, and a hand count of 0 once hid 11 real calls.
