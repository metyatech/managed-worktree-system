# Changelog

## Unreleased

- No unreleased changes.

## 2.2.1 - 2026-04-14

- Fix `createTaskWorktree` so it rolls back the worktree link, the on-disk
  directory, the task branch, and the state registry entry when any step
  AFTER `git worktree add` fails (e.g. a failing `post_create` hook or a
  bootstrap copy error). Previously these failures left behind a "phantom"
  directory — often already bootstrapped with `node_modules` and
  `package.json` — that blocked subsequent `createTaskWorktree` calls for
  the same slug with `worktree_path_occupied` and produced zombie entries
  in downstream orchestrators that crawl the seed parent.

## 2.2.0 - 2026-04-14

- Add `mwt drop` so an active managed task worktree can be explicitly removed
  from the CLI, with optional local branch deletion and dry-run support.
- Fix subcommand-specific help so `mwt <command> -h` shows that command's help
  instead of always falling back to top-level help.
- Fix the documented `mwt version` subcommand and add CLI contract tests that
  cover per-subcommand help, version, and create-to-drop task lifecycle flows.

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
