# 045. Split and integrate an order

A lead can divide a large order into independently reviewable changes. Each child has its own order text, worker, worktree and review. A final parent run can test their combined behavior before a person merges the parent into the project base.

## Configure the lead

Use `split` as the first [phase](044-phases.md), followed by optional read-only phases and a final write phase.

```yaml
phases:
  feature:
    - { id: divide, mode: split, role: investigator }
    - { id: integrate, mode: write, role: developer }
split:
  approve:
    feature: manual
```

The lead has the same enforced read-only launch and worktree checks as a planning worker. Its final ready report carries `subtasks`. Each item has a unique `key`, a `title`, a supported child `kind`, and a Markdown `body` under 16 KiB with its own Acceptance bullets. Optional `needs` lists sibling keys. A proposal has two to eight children and an acyclic dependency graph. The prompt lists eligible kinds. Children can use their kind's own phases. Splitting stops at one level.

## Decide the proposal

The report arrives first. The parent waits in `awaiting-user`. Open the split card to read each child's body and dependencies. Keep at least two children, edit their titles or kinds, then accept. Dropping a child also drops references to its key. To ask the lead for a different division, send the card back with a note.

```sh
alba orders show CACHE
alba orders act CACHE accept-split
alba orders act CACHE rework --note "Separate storage from formatting"
```

The last two commands are alternative decisions on a pending proposal. To accept automatically for one kind, set its entry under `split.approve` to `auto`. A scalar `split.approve: auto` applies to every split kind. The default is manual. Both approval paths record the decision against the proposal.

API clients can send `action: "accept-split"` to `POST /api/orders/:tag/actions`. Include the proposal's numeric `report` to reject a stale decision. Optional `edits` lists the retained keys in order, each with optional `title` and `kind`. Order detail exposes the proposal, pending status and decision in `split`. Summaries and detail expose each child's `parent` and the parent's `children` with their current stages. The board groups children under an expandable progress count.

## Child branches and integration

Approval uses the parent's normal integration branch, creating it from the configured local base if needed. Retained tasks become numbered orders such as `CACHE.1` and `CACHE.2`. Each starts from the parent branch tip at its first run. Sibling keys become order tags in `needs`. A dependent child waits for its prerequisites to merge. The usual `dispatch.auto_merge_base` and `checks.base_merged` settings also apply to children, using the parent branch as their base.

Approving a child prepares a `--no-ff` merge in a temporary detached worktree. With checks passed and the parent checkout idle and clean, Alba fast-forwards the parent's linked worktree to that exact commit. A `merged-into-parent` event records the parent and commit. On conflict Alba discards the temporary worktree and sends the child back with the conflicting paths and parent commit. The worker resolves the conflict on its own branch and delivers again.

The parent waits in `waiting-children` while any child is neither merged nor cancelled. Its stage reason gives the outstanding count. When the count reaches zero the next parent phase queues. It runs on the integrated parent branch and receives a list that identifies cancelled children. After the final report, review and merge the parent into the project base by hand, then approve it.

## Cancellation

Cancelling one child leaves its siblings in place. To cancel the whole family use the parent's confirmation dialog or `alba orders cancel CACHE --confirm`. The API accepts `confirm: true` on the cancel action. Open children follow normal cancellation and process identity checks. Completed children retain their deliveries.
