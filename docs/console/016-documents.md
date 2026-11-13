# 016. Project documents

A project keeps design notes and research as Markdown in its own tree. The console lists them, reads one, and searches the text. Nothing here is on until the project file has a `docs` section. The calls are also listed at the end of [010](010-api.md).

## Configuration

```yaml
docs:
  files: ["docs/gdd.md", "docs/**/*.md"]   # paths or globs, relative to the project root
  research: "docs/research"                # optional; files here are a separate group
```

- A plain path is listed even when the file is not written yet. It comes back with `exists: false`, `bytes: 0` and no `modified`.
- A glob keeps only `.md` files. The walk skips `.git` and `node_modules`. A link to a directory is not walked (it could leave the project or loop). A directory whose real path, junctions followed, is outside the project root is not entered. A linked file is listed only when its target stays inside the root.
- The list is built in two passes. First every plain path, in the order it was written. Then every glob match, sorted by path. A path that already appeared is skipped.
- `research` is an optional folder. A file whose path is that folder, or is under it, has group `research`. Every other file has group `docs`.
- With no `docs` section, `GET /api/docs` returns `enabled: false`, an empty list and a note that says how to turn it on. Reading or searching then is 404.

Paths in the section are relative to the project root. An absolute path, a drive prefix or a `..` segment is refused when the project file is loaded.

## Calls

| Call | Returns |
|---|---|
| `GET /api/docs?project=` | `DocList`: `enabled`, `items`, and `note` when the feature is off |
| `GET /api/docs/file?project=&path=` | `DocFile`: `title`, `group`, `headings`, and the raw `markdown` |
| `GET /api/docs/search?project=&q=&limit=` | `DocSearch`: `count` and `items` |

The title is the first level-1 ATX heading (`#`, not inside a fence). With none, it is the file name. Headings are ATX levels 1 to 3, each with `text`, `slug` and a 1-based `line`. The slug is lower case, with punctuation folded to `-`; a repeat gets `-1`, `-2`.

### What may be read

`GET /api/docs/file` allows a path that is in the list, or a `.md` file in the directory of a listed document or in a subdirectory of that directory. A listed file in the project root (its directory is empty) therefore allows any `.md` file in the project.

The real path, with links and junctions followed, must stay inside the project root. A path outside the list, or whose real path leaves the root, is 403. An allowed path that is not written yet is 404. An empty path is 400 (`"path" is required`).

### Search

Matching is a case-insensitive substring, so a Chinese query matches Chinese text. There is one hit per line. Files are searched in list order. Each hit has `path`, `title`, the nearest heading at or above the line (`text` and `slug`; when the match is above every heading, `slug` is empty and `text` is the title), `line`, and a `snippet` of about 160 characters. The matched text in the snippet is wrapped in U+0001 and U+0002. Whitespace in the snippet is collapsed.

`limit` defaults to 30 and is clamped to the range 1–100. A query of 200 characters or more is 400. An empty or whitespace query returns no hits.

The text of each file is kept in memory, keyed by the project root and the relative path. A later search reads the file again only when its size or modified time has changed.

## Console

Documents is in the side navigation . Cards are grouped as Documents and Research, each with the title, the path and when the file was last modified. A missing file is greyed, says it is not written yet, and is not a link. The search box at the top waits briefly, then lists hits; choosing one opens the reader at that heading.

The reader renders GitHub-flavoured Markdown: tables, task lists and code. A table of contents sticks to the left on a wide window; its anchors are the heading slugs from the API. Raw HTML is shown as text and is not rendered. A relative link to another `.md` file opens in the reader. A relative image or video (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `mp4`, `webm`, `mov`) is loaded through the existing confined `GET /api/files`. A link that leaves the project, or that uses a scheme other than http or https — including a protocol-relative link, `javascript:`, `data:`, `file:` and `mailto:` — is plain text. Ctrl/Cmd K lists the documents that exist, by title.
