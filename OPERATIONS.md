# Operations Runbook

## Purpose

This runbook defines how humans and AI agents should operate repositories that adopt `mwt`.

## When to use `mwt`

Use `mwt` when a repository needs:

- parallel human and AI work without dirtying the seed worktree
- preserved sibling-relative topology such as `../shared-repo`
- explicit delivery with rebase, verify, push, and seed sync
- deterministic cleanup of task worktrees

Do not use `mwt` when:

- the repository is already managed by a different canonical worktree system
- contributors cannot run Git worktrees locally
- the repository requires mutable shared runtime state in the seed worktree

## Seed worktree policy

The seed worktree is the visible repository root. Treat it as a clean bootstrap surface, not a tracked editing surface.

Allowed in the seed worktree:

- tracked files that exactly match the declared base branch
- ignored bootstrap files such as `.env.local`
- editor-local settings that are intentionally copied into task worktrees by allowlist

Not allowed in the seed worktree:

- tracked edits
- long-lived conflict state
- mutable runtime artifacts shared across tasks, such as `node_modules/`, `.venv/`, local databases, or build outputs

## Standard operator flow

1. Start from a clean seed worktree on the intended base branch.
2. Run `mwt create <task-name>`.
3. Work only inside the new task worktree.
4. Commit inside the task worktree.
5. Run `mwt deliver <task-name> --target <branch>`.
6. If delivery succeeds, run `mwt prune --merged --with-branches`.

## Human workflow

- Use the seed worktree to inspect the latest branch state and to maintain ignored bootstrap files.
- Do not stage, commit, or rebase tracked files from the seed worktree.
- Resolve conflicts inside the task worktree and rerun `mwt deliver --resume`.

## AI workflow

- Create a fresh task worktree for each actionable task.
- Treat `mwt --json` output as the source of truth for success, failure, and recovery hints.
- Do not write tracked files in the seed worktree.
- If a lock is held, wait for the owning operation or use the reported recovery action instead of bypassing it.

## Bootstrap guidance

- Copy only allowlisted ignored files from the seed worktree.
- Keep `.env*` and similar operator-local configuration in the seed worktree if those files are intentionally propagated.
- Do not copy mutable dependency directories or build outputs by default.
- If a repository genuinely needs extra bootstrap files, add them to `.mwt/config.toml` explicitly.

## Conflict and resume

If `mwt deliver` stops with a conflict:

1. Inspect the task worktree.
2. Resolve the conflict there.
3. Re-run `mwt deliver --resume`.

Do not resolve the conflict by editing tracked files in the seed worktree.

## Recovery and cleanup

- Use `mwt doctor --fix` when registry state drifts from actual worktrees.
- Use `mwt prune --merged` for delivered task worktrees.
- Use `mwt prune --abandoned` only when a task is intentionally discarded.
- If the seed worktree is not clean, stop and repair that policy violation before creating or delivering more tasks.
