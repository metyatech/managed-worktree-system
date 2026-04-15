# Managed Worktree System

`@metyatech/managed-worktree-system` is a policy-driven Git worktree CLI for parallel human and AI task work. The executable is `mwt`.

## Purpose

- keep the seed checkout tracked-clean and synchronized to the remote target branch
- create isolated sibling task worktrees for human and AI edits
- preserve repository-relative filesystem topology such as `../shared-repo`
- make delivery explicit: rebase, verify, push, sync, and cleanup

## Mental model

- The seed is a normal non-bare repository checkout at the visible project root.
- The seed stays tracked-clean and acts as the bootstrap source for ignored local files such as `.env.local`.
- Every tracked edit happens in sibling task worktrees created by `mwt create`.
- `.mwt-worktree.json` is a local runtime marker, not a file for version control.
- `mwt deliver` is the explicit integration step from a task worktree back to the target branch.

## Migrating from 1.x

`mwt` 1.x used a bare-backed seed layout. `mwt` 2.x does not. There is no in-place migration command in 2.x.

- Start from a normal non-bare repository checkout that you want to keep as the seed.
- Confirm there are no active task worktrees you still need from the old 1.x layout.
- Run `mwt init` in the normal repository checkout.
- Recreate task worktrees from that seed with `mwt create`.

## Supported environments

- Windows PowerShell is the currently verified operator environment
- Git and Node.js 22 or later are required
- npm 11.12.1 or later is recommended for authenticated scoped-package install and `npx` flows
- the command surface is intended to remain cross-platform where Git behavior permits

## Install

Global install:

```powershell
npm install -g @metyatech/managed-worktree-system
```

One-shot execution without a global install:

```powershell
npx @metyatech/managed-worktree-system --version
```

Repository-local development install:

1. Install Node.js 22 or later.
2. Install Git.
3. Run `npm install`.
4. Run `npm run verify`.

## Programmatic API

`@metyatech/managed-worktree-system` also exports the core repository operations
for other tools such as orchestrators and repository managers.

Example:

```js
import {
  createTaskWorktree,
  deliverTaskWorktree,
  dropTaskWorktree,
  loadConfig,
} from '@metyatech/managed-worktree-system';

const seedRoot = process.cwd();
await loadConfig(seedRoot);
const created = await createTaskWorktree(seedRoot, 'manager-task-123', {
  createdBy: 'manager',
  pathTemplate: '{{ seed_parent }}/{{ repo }}-mgr-{{ slug }}-{{ shortid }}',
  branchTemplate: 'mgr/{{ slug }}/{{ shortid }}',
});

await deliverTaskWorktree(created.worktreePath, { target: 'main' });
await dropTaskWorktree(created.worktreePath, {
  force: true,
  deleteBranch: true,
  forceBranchDelete: true,
});
```

Programmatic create options:

- `base`: override the configured base branch for this task worktree.
- `target`: override the configured target branch recorded in task metadata.
- `bootstrap`: force or skip bootstrap copying.
- `copyProfile`: choose a bootstrap profile from `.mwt/config.toml`.
- `createdBy`: record the logical creator in `.mwt-worktree.json`.
- `pathTemplate`: override the configured task worktree path template for this
  call.
- `branchTemplate`: override the configured task branch template for this call.

Programmatic delivery options:

- `target`: override the delivery target branch for this call.
- `allowDirtyTask`: skip the tracked-clean guard inside the task worktree.
- `resume`: resume a previously interrupted or conflict-marked delivery.

## Usage

Core flow:

1. Initialize an existing repository:

   ```powershell
   mwt init --base main --remote origin
   ```

2. Create a task worktree:

   ```powershell
   mwt create feature-auth
   ```

3. Work and commit inside the task worktree, then deliver:

   ```powershell
   mwt deliver feature-auth --target main
   ```

4. If you no longer need an active task worktree, drop it explicitly:

   ```powershell
   mwt drop preview-auth --delete-branch --force-branch-delete
   ```

5. Prune delivered worktrees:

   ```powershell
   mwt prune --merged --with-branches
   ```

End-to-end example:

```powershell
mwt init --base main --remote origin
mwt create feature-auth
mwt create preview-auth --dry-run --json
mwt list --kind task --status active --json
mwt deliver feature-auth --target main
mwt drop preview-auth --delete-branch --force-branch-delete
mwt sync --base main
mwt prune --merged --with-branches
mwt doctor --fix
```

If you prefer not to install globally, replace `mwt` with `npm exec -- mwt` inside a local clone or with `npx @metyatech/managed-worktree-system`.

### Commands

#### `mwt init`

Initialize the current normal non-bare repository for managed worktree operation.

Parameters:

- `--base <branch>`: default target branch recorded in `.mwt/config.toml`.
- `--remote <name>`: default remote recorded in `.mwt/config.toml`.
- `--force`: allow initialization even when tracked files are already dirty.

Example:

```powershell
mwt init --base main --remote origin --json
```

#### `mwt create <name>`

Create a sibling task worktree and branch from the configured remote base.
When the seed repository contains Git submodules, `mwt create` also runs
`git submodule update --init --recursive` inside the new task worktree before
project hooks execute, so hook/tooling paths backed by submodules are present.

Parameters:

- `<name>`: task worktree name.
- `--name <name>`: alias for the positional worktree name.
- `--base <branch>`: override the configured base branch for this worktree.
- `--copy-profile <profile>`: choose a bootstrap copy profile from `.mwt/config.toml`.
- `--run-bootstrap`: force bootstrap copy even when `bootstrap.enabled = false` in config.
- `--no-bootstrap`: skip copying allowlisted ignored files such as `.env.local`.

Example:

```powershell
mwt create feature-auth --base main --copy-profile local
```

#### `mwt list`

List the seed worktree and managed task worktrees.

Parameters:

- `--all`: include external unmanaged Git worktrees in the listing.
- `--kind <seed|task>`: filter by worktree kind.
- `--status <active|delivered|conflict|abandoned|healthy>`: filter by managed status.

Example:

```powershell
mwt list --kind task --status active --json
```

#### `mwt deliver [<name>]`

Rebase a task worktree onto the remote target branch, run verification, push, and sync the seed worktree.

`deliver` is not just "push this branch". It is the explicit integration gate that:

1. fetches the target branch
2. rebases the task worktree onto the latest target
3. runs pre-deliver hooks
4. runs the configured verify command in the rebased task worktree
5. pushes `HEAD` to the target branch
6. fast-forwards the seed to the delivered target

This verify step is intentional. A pre-commit hook checks each commit in isolation, but `deliver` verifies the code after rebasing onto the latest target branch. That catches integration failures that a local pre-commit hook cannot see. Use both when possible: pre-commit for early feedback, `deliver` verify for the final integration gate.

Parameters:

- `<name>`: task worktree name or worktree id. If omitted, the current task worktree is used.
- `--target <branch>`: override the configured delivery target branch.
- `--allow-dirty-task`: skip the pre-deliver tracked-clean task check.
- `--resume`: rerun delivery after a previously recorded conflict or interruption.

Example:

```powershell
mwt deliver feature-auth --target main --json
```

#### `mwt sync`

Fast-forward the seed worktree to the configured remote branch.

Parameters:

- `--base <branch>`: override the configured branch for this sync.

Example:

```powershell
mwt sync --base main
```

#### `mwt drop [<name>]`

Remove an active managed task worktree that you no longer need.

If branch deletion or another later cleanup step fails after the worktree
itself has already been detached, `mwt drop` still removes the task worktree
and registry entry before returning an error so the repository does not keep a
half-dropped managed task.

Parameters:

- `<name>`: task worktree name or worktree id. If omitted, the current task worktree is used.
- `--force`: allow removal when tracked changes or unexpected untracked files remain.
- `--delete-branch`: delete the local task branch after removing the worktree.
- `--force-branch-delete`: use force branch deletion semantics when removing the local branch.

Example:

```powershell
mwt drop feature-auth --delete-branch --force-branch-delete --json
```

#### `mwt prune`

Remove managed task worktrees that are safe to delete.

When one prune target hits a later cleanup failure, `mwt prune` still finishes
the safe cleanup steps for that target and continues pruning the remaining
eligible worktrees before reporting the incomplete cleanup.

Parameters:

- `--merged`: prune delivered task worktrees.
- `--abandoned`: prune abandoned task worktrees.
- `--force`: allow pruning when tracked changes or unexpected untracked files remain.
- `--with-branches`: delete the local task branch after confirming it is merged.

Example:

```powershell
mwt prune --merged --with-branches --json
```

#### `mwt doctor`

Validate managed metadata and optionally repair registry drift.

Parameters:

- `--fix`: repair missing or stale registry entries when possible, remove empty
  stale worktree directories, and delete stale local task branches that no
  longer contain unique commits. If one cleanup step still fails, doctor keeps
  any other safe repairs, then returns a structured incomplete-cleanup error so
  callers can show both the fixes that succeeded and the failures that remain.
- `--deep`: include lock files, orphan sibling directories, and seed topology checks.

With `--deep --fix`, `mwt doctor` also removes empty orphan sibling directories
that match the managed naming pattern but are no longer live worktrees.

Example:

```powershell
mwt doctor --fix --json
```

#### `mwt version`

Print the CLI version.

Example:

```powershell
mwt version
```

### Global flags

- `--json`: emit a single JSON envelope on stdout.
- `--output <path>`: also write the JSON envelope to a file.
- `--dry-run`: return a non-mutating action plan instead of changing repository state.
- `--yes`: approve hook execution or other guarded automation steps.
- `--quiet`: suppress human-readable stderr summaries.
- `--verbose` or `-v`: reserve verbose logging for future expansion.
- `--help` or `-h`: show help for the top-level CLI or a specific command.
- `--version` or `-V`: print the CLI version.

## Project configuration

Project policy lives in `.mwt/config.toml`.

- `default_branch`: default base and delivery target branch, usually `main`.
- `default_remote`: default remote, usually `origin`.
- `task_worktree_dir_template`: path template for sibling task worktrees. Available tokens are `repo`, `seed_root`, `seed_parent`, `slug`, and `shortid`.
- `task_branch_template`: local task branch name template. Available tokens are `slug` and `shortid`.
- `bootstrap.enabled`: default on or off switch for ignored-file bootstrap copy.
- `bootstrap.default_profile`: default bootstrap profile name.
- `bootstrap.profiles.<name>.include`: allowlisted glob patterns to copy from the seed, such as `.env.local`.
- `bootstrap.profiles.<name>.exclude`: excluded globs inside that profile, such as `node_modules/` or `dist/`.
- `verify.command`: command that `mwt deliver` runs after rebasing onto the latest target branch.
- `hooks.pre_create.*`, `hooks.post_create.*`, `hooks.pre_deliver.*`, `hooks.post_deliver.*`: named project hooks for lifecycle automation.

The full schema and examples are documented in [docs/managed-worktree-system-implementation-spec-v1.md](docs/managed-worktree-system-implementation-spec-v1.md).

## Development commands

- `npm run lint`
- `npm run test`
- `npm run package:check`
- `npm run build`
- `npm run verify`
- `npm run format`

## Environment variables

- None required.

## Operations

Operational guidance lives in [OPERATIONS.md](OPERATIONS.md). Read it before adopting `mwt` in a shared repository.

## SemVer policy

- Major releases change the CLI contract, JSON envelope, on-disk `.mwt/` format, or seeded-worktree policy in a backward-incompatible way.
- Minor releases add backward-compatible commands, flags, policy checks, or workflow automation.
- Patch releases fix bugs, tighten validation, or improve documentation without breaking an existing workflow contract.

## Release / deploy

Release flow for maintainers:

1. Update version metadata and `CHANGELOG.md`.
2. Run `npm run verify`.
3. Push `main`.
4. Create a Git tag that matches the package version, for example `v1.0.0`.
5. Create a GitHub Release for that tag.
6. Publish with `npm publish`.
7. Verify the published artifact with `npm view`, `npx`, and a global install or update.

## Links

- [Managed Worktree System Design](docs/managed-worktree-system-design.md)
- [Managed Worktree System Implementation Spec v1](docs/managed-worktree-system-implementation-spec-v1.md)
- [Operations Runbook](OPERATIONS.md)
- [CHANGELOG.md](CHANGELOG.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE)
