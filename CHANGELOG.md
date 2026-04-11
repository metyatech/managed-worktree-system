# Changelog

## Unreleased

- No unreleased changes.

## 2.1.1 - 2026-04-11

- Keep `.mwt-worktree.json` local runtime markers out of normal Git status by
  adding them to the managed local exclude set for both the seed and newly
  created task worktrees.

## 2.1.0 - 2026-04-11

- Export a supported JavaScript and TypeScript API for `mwt` repository
  operations so other tools can create, deliver, and drop managed task
  worktrees without shelling out.
- Add per-call `pathTemplate` and `branchTemplate` overrides to the programmatic
  task worktree creation flow so orchestrators can reserve manager-specific
  naming without changing the seed repository defaults.
- Add programmatic task worktree drop support and tests for manager-created task
  worktrees.

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
