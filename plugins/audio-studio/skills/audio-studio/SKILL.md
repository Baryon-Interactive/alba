---
name: audio-studio
description: Make music, instrument loops and sound effects with the audio-studio plugin (Stable Audio 3 on this machine), edit clips and export them for the game.
---

# Music and sound effects through audio-studio

Use the tools of the `audio` MCP server: `generate_audio`, `edit_audio` (variation, inpaint, continue), `process_audio` (trim, loop,
fades, normalize, export) and `unload_models`. They run Stable Audio 3 on this machine's GPU; calls are free but slow to start (the
model loads on the first call, ~30 s). Instrumental only: it cannot sing or speak.

- **Where.** Each call answers the absolute path of every file it wrote, with a `.json` sidecar (prompt, seed, settings). Copy the files
  you keep into the order's folders and commit them; leave the rest. `process_audio` reads any path and writes a new file.
- **Prompt.** English, one or two dense sentences, at most ~45 words, no markdown, no vocal words. Pick `audio_type`: `music` (BGM),
  `instrument` (solo, stem, loop; give `bpm`), `sfx` (effects, ambience, one-shots). Put the user's own wording in `original_idea`.
  - Music: genre and adjectives, main instruments, supporting layers, drums, mood; tempo in `bpm`.
  - SFX: fill `sound_source` (what makes it), `sound_action` (attack, decay, movement), `sound_material` (texture, timbre) and
    `sound_space` (room, distance, dry or reverberant). Without `audio_type: sfx` effects come out as music.
- **Length.** Impacts and clicks 1-3 s, actions 3-6 s, ambience 6-15 s, loops 6-20 s, BGM 60-180 s (max 380 s).
- **Candidates.** Results vary a lot per seed: ask `variations` 2-4 and pick; candidate n has seed `seed + n - 1`, so any one can be
  made again. Keep `steps` 8 and `cfg` 1; raise `cfg` to 3-7 only for stricter prompts or a `negative_prompt` (about twice as slow).
- **Structure.** Timing words in the prompt ("climax at 15 s") are not followed; generate, then `edit_audio` inpaint or continue.
- **For the game.** Generated files are not mastered. Export with `process_audio`: game SFX `normalize: peak`, `mono: true` for
  positional sounds, `trim_silence` for one-shots; BGM `normalize: loudness` at -16 LUFS, `loop: true` for loops; `format: ogg`,
  `sample_rate: 48000` unless the order says otherwise.
- **GPU.** When you are done generating, call `unload_models` so the GPU is free for the editor and other runs.
- **Provenance.** For every file you keep, report the prompt, `audio_type`, seed, length and the model (in the sidecar), and add it to
  the project's third-party or credits record if the project keeps one (generated with Stable Audio 3, Stability AI Community License).
- **Listening.** You cannot hear the result. Say so; report the peak and loudness numbers the tools give, and leave the pick to a person
  unless the order says how to choose.

Alba can run the same calls without a worker: `alba tools run audio-studio generate --order <TAG> --input in.json` (also `edit`,
`process`); the files land in the job's folder.

An order or a note may change any of this; it wins over this skill.
