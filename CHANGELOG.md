# Changelog

## Unreleased

- No unreleased changes.

## 1.0.1 - 2026-04-11

- Fix the published executable by shipping a dedicated top-level `bin/mwt.js` shim for npm installs and `npx`.
- Deprecate the broken `1.0.0` publish in favor of this patch release.

## 1.0.0 - 2026-04-11

- Release the first public `mwt` CLI with `init`, `create`, `list`, `deliver`, `sync`, `prune`, `doctor`, and `version`.
- Publish the bare-backed seed worktree model, task worktree delivery pipeline, and lock/lease concurrency controls.
- Add public repository metadata, operations documentation, issue templates, release guidance, and package publishing support.
