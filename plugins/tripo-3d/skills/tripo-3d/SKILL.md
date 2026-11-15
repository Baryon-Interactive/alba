---
name: tripo-3d
description: Make 3D models with the Tripo Studio tools (tripo_*) of the tripo-3d plugin, inside the order's credit cap.
---

# 3D models through Tripo Studio

The `tripo` MCP server is Tripo Studio with the member account logged in on this machine. Its creation tools cost credits from
that account's wallet. Use only the `tripo_*` tools; never another 3D service unless the order says so.

1. **Session.** Call `tripo_auth_status` first. If it is not authenticated, stop the 3D part and say so in the report: a person
   logs in. Never call `tripo_auth_login`, `tripo_auth_import` or `tripo_auth_logout`.
2. **Quote first.** Price every paid call with `tripo_quote_operation` (`kind` and the cost-related `input`). An unknown price is
   not zero. Make an Alba quote for the order with what you will spend (`alba credits quote <TAG> --service tripo --unit credits
   --cap N`), and run `alba credits gate <TAG> <quote> --need N` before each paid call; do not go on when it refuses.
3. **Creation opens a form.** `tripo_generate_model` (and texture, PBR, export) opens a configuration form that submits itself after
   60 seconds. Call `tripo_get_configuration_review` with its `review_id` and `wait_ms: 60000` until it is submitted, then follow
   the final `task_id` with `tripo_task_wait`. Never call the creation tool again for the same model: that is a second charge.
4. **Download** with `tripo_download` (`task_id`, `path` inside your worktree). Another format than GLB is exported first with
   `tripo_export_model` (no credits), through the same form.
5. **Book the spend:** `alba credits spend <TAG> <quote> --amount N --what "..."` with what the wallet shows (`tripo_get_payment`
   before and after).
6. **Report** the task ids, the settings (tier, face limit, texture), the credits spent and the files.

**Other operations** (plugin 1.1): parts - `tripo_segment_model`, then `tripo_complete_parts` (quick_cap closes holes,
ai_completion regrows a part; part names from `tripo_get_model` include parts) and `tripo_remesh_model` per part; textures -
`tripo_generate_texture` (whole model or `part_names`), `tripo_upscale_texture`, Magic Brush (`tripo_render_model` ->
`tripo_preview_texture_edit` -> `tripo_apply_texture_edits`); rigging - `tripo_rig_model` (V3, `skeleton_preset` unity for
Unity Humanoid), `tripo_animate_model` with a preset id, or `tripo_generate_motion` + `tripo_apply_motion`; Smart UV -
`tripo_generate_uv` then `tripo_apply_uv`; `tripo_import_model` brings a local GLB in (free). Every paid one follows steps 2-5.
Tripo's own quote may say unknown (its pricing table expired): then quote the project's ceiling and book what the wallet shows.

A white mesh (`smart_mesh`) has no textures: texture it with `tripo_generate_texture`, then `tripo_generate_pbr`, as the order asks.
An order or a note may change any of this; it wins over this skill.
