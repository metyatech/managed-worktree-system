# Changelog

## Unreleased

- No unreleased changes.

## 2.0.0 - 2026-04-11

- Change `mwt init` and the managed topology to use a normal non-bare seed repository instead of the 1.x bare-backed seed layout.
- Keep managed runtime ignore rules in the seed repository's normal `.git/info/exclude`.
- Reject bare repositories and linked worktrees at `mwt init` with explicit unsupported-state errors.
- Document that `deliver` remains the integration boundary and still runs verify after rebasing onto the latest target branch.
- Add migration guidance for replacing a 1.x bare-backed seed with a new non-bare seed checkout.

## 1.0.1 - 2026-04-11

- Fix the published executable by shipping a dedicated top-level `bin/mwt.js` shim for npm installs and `npx`.
- Deprecate the broken `1.0.0` publish in favor of this patch release.

## 1.0.0 - 2026-04-11

- Release the first public `mwt` CLI with `init`, `create`, `list`, `deliver`, `sync`, `prune`, `doctor`, and `version`.
- Publish the bare-backed seed worktree model, task worktree delivery pipeline, and lock/lease concurrency controls.
- Add public repository metadata, operations documentation, issue templates, release guidance, and package publishing support.
