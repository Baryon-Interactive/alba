---
name: image-gateway
description: Make or edit pictures with the image_generate tool of the image-gateway plugin (an OpenAI-compatible images endpoint).
---

# Pictures through image-gateway

Use the `image_generate` tool of the `image` MCP server. It saves the pictures in `out_dir` and answers each file with its real
pixel size. Never use another image tool or API unless the order says so.

- **Where.** `out_dir` is an absolute folder in your worktree (for example the order's art folder). Commit the pictures you keep.
- **Prompt.** Write the prompt in full in the call. It is sent as it is; put style, subject, framing and what must not appear.
- **Background.** Always give `background`: `transparent` for cut-out figures and pieces, `opaque` for scenes and sheets.
- **References.** With `refs` (absolute paths) the call becomes an edit guided by those pictures: a style sheet, the front of a piece
  for its back.
- **Size.** The model may return another size than `size` asks for. Read the size in the answer, record it, and do not call an
  upscale native resolution.
- **Calls.** Stay inside the order's cap on calls (without one: at most 3 calls per target picture). A failed call: read the error,
  retry once for a dropped connection, otherwise stop the picture part and say so in the report.
- **Provenance.** For every picture you keep, report the model, the prompt (or its file), the time and the number of calls, successful
  and failed.
- **Looking.** Before judging a picture, look at a copy whose long side is at most 1024 px; look at details as 100% crops.

An order or a note may change any of this; it wins over this skill.
