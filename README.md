# Managed Worktree System

`@metyatech/managed-worktree-system` is a policy-driven Git worktree CLI for parallel human and AI task work. The executable is `mwt`.

## Purpose

- keep the seed checkout tracked-clean and synchronized to the remote target branch
- create isolated sibling task worktrees for human and AI edits
- preserve repository-relative filesystem topology such as `../shared-repo`
- make delivery explicit: rebase, verify, push, sync, and cleanup

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

4. Prune delivered worktrees:

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
mwt sync --base main
mwt prune --merged --with-branches
mwt doctor --fix
```

If you prefer not to install globally, replace `mwt` with `npm exec -- mwt` inside a local clone or with `npx @metyatech/managed-worktree-system`.

### Commands

#### `mwt init`

Initialize the current repository for managed worktree operation.

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

#### `mwt prune`

Remove managed task worktrees that are safe to delete.

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

- `--fix`: repair missing or stale registry entries when possible.
- `--deep`: include lock files, orphan sibling directories, and seed topology checks.

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
