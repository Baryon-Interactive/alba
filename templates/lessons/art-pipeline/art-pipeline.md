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

## ALBA-ART-08 Write the art bible before the first content asset
- tags: art, image, tripo, engine
- rule:
  - Before any content order, write and approve one art bible: direction (one sentence and comparison pictures), palette in hex, value ranges for ground and characters, a scale ruler (character, tile or plot, prop, building), material classes and their parameters, lighting preset fields, an effects size and timing table, and an asset acceptance list.
  - A new bible lists which earlier style rules it replaces; mark them superseded where they are written.
  - Orders cite the section of the bible they follow.
- why: a project that started without one ended with contradictory style rules and every batch judged against a different idea.

## ALBA-ART-09 Generation settings match what the shaders need
- tags: art, image, tripo, engine
- rule:
  - Before a batch, generate one sample and check its channels against the shading plan: normal, roughness and metal, emissive, and whether light is baked into the colour.
  - Write the settings that passed into the order and keep them for the batch; change them only with a new sample.
- why: a batch generated without the maps its shaders expected looked flat under the game's lights.

## ALBA-ART-10 Judge pictures by range and subject contrast, not mean brightness
- tags: art, image, engine
- rule:
  - Acceptance of a scene or capture reports the highlight share, p5 and p95 luminance, how much brighter the subject is than its surround, and the subject's height in pixels (`alba review <TAG> sheet` gives them; a `<name>.mask.png` marks the subject).
  - A target for the mean alone is not enough: name a highlight share and a subject contrast too.
- why: captures that met the mean brightness target were grey and flat, with no highlights at all.

## ALBA-ART-11 Consolidate, do not stack passes
- tags: art, engine
- rule:
  - When a new pass would hide or move what an earlier pass placed, first fold the scene into one layout data file, then change that.
  - Never scale a delivered mesh non-uniformly, or to fit a box in screen pixels; fix the size at the source against the scale ruler.
- why: a battlefield built from six passes that overrode each other could not be changed without breaking another pass.

## ALBA-ART-12 A licence line before any asset that was not generated
- tags: art, image, tripo
- rule:
  - Before a downloaded, bought or inherited asset is used, record its source, licence and link next to it.
  - An inherited asset with no licence is removed or recorded before the next content order; it is never kept "for now".
- why: legacy assets with no licence record were still in the game at review.

## ALBA-ART-13 Compare key art and the game side by side every milestone
- tags: art, image, engine
- rule:
  - At each milestone, put the 2D key art and an in-game capture at the same framing next to each other.
  - Write the gaps (value, saturation, scale, detail) into the next batch of orders.
- why: key art and the game drifted apart unnoticed until a review months later.
