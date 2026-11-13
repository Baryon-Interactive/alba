# {tag}

## Intake

This order imports the following design document set:

{documents}

The existing design library snapshot is available at `{snapshot}`. It is written in the worker worktree when the run starts.

At run start, read `.alba/intake/blocks.json`. It contains the document id, version, order, status, sequence, complete block text, heading path and canonical reference for every non-retired block. Use the exact reference format `<doc-id>@<version>#<block>` in all coverage and change-set sources. Decision sources use the configured decision id (for example `D150`). Documents may use any language; keep entity ids in English while text fields may use the document language.

## Formats and a worked example

Read these files of the alba installation instead of searching for them (absolute paths):

- Change-set format (`title`, `decision`, `changes` with `op`, `kind`, `id`, `fields`) and the entity kinds: `{alba_root}/docs/libraries/027-design-library.md`
- Intake rules (coverage classes, gaps, questions, the check): `{alba_root}/docs/libraries/030-design-intake.md`
- Coverage schema: `{alba_root}/schema/intake-coverage.schema.json`
- A complete worked answer for a small document set: `{alba_root}/examples/intake-demo/answers/alba/` (`design/changes/intake-RUN.json`, `design/changes/intake-UI.json`, `intake/coverage.json`, `intake/questions.md`)

## Worker output contract

For every system, write `.alba/design/changes/intake-<SYSTEM>.json` using the existing design change-set format. Every rule must include `sources` with `{kind: doc, ref}` or `{kind: decision, ref}`. Each system needs at least {min_targets} targets; every target includes a metric, bounds, unit and command, and may leave `measure` empty.

Write `.alba/intake/coverage.json` and classify every non-retired document block as `mapped`, `superseded`, `out-of-scope`, or `unclear`. The schema is `schema/intake-coverage.schema.json`. A minimal report is `{"version":1,"blocks":[{"ref":"core@1#b123","mapped":["SYS-R01"]}]}`. Every `unclear` block names a gap id in the form `<SYS>-G<nn>`; each question is a Markdown list item and includes at least one existing gap id. Write `.alba/intake/questions.md` even when there are no open questions.

New projects use `not-started` systems and the default milestones M-CORE, M-SLICE, M-CONTENT and M-RELEASE when the documents do not define stages.

## Commit the outputs

`.alba/` is excluded from git in this worktree (the repository's `info/exclude`), so `git add` alone skips these files. The review and the acceptance check read only what is committed on the branch. Add them with `-f` and commit:

```
git add -f .alba/intake/coverage.json .alba/intake/questions.md .alba/design/changes/intake-*.json
git commit -m "{tag}: intake outputs"
```

Do not commit `.alba/intake/blocks.json` or `.alba/design/snapshot.json`; they are inputs written at run start.

## Acceptance

- From this worktree, run `{alba_command} intake check --dir .alba` (`--dir` is relative to the current folder) and fix every issue it lists.
- Ensure every rule has a resolvable `sources` entry.
- Ensure every block is classified exactly once and every unclear gap is listed in `questions.md`.
- Ensure the outputs are committed: `git ls-files .alba` lists `coverage.json`, `questions.md` and every change set.
