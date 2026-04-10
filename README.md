# Managed Worktree System

`managed-worktree-system` is a policy-driven Git worktree CLI for parallel human and AI task work. The executable is `mwt`.

## Purpose

- keep the seed checkout tracked-clean and synchronized to the remote target branch
- create isolated sibling task worktrees for human and AI edits
- preserve repository-relative filesystem topology such as `../shared-repo`
- make delivery explicit: rebase, verify, push, sync, and cleanup

## Supported environments

- Windows PowerShell is the currently verified operator environment
- Git and Node.js 22 or later are required
- the command surface is intended to remain cross-platform where Git behavior permits

## Setup

1. Install Node.js 22 or later.
2. Install Git.
3. Run `npm install`.
4. Run `npm run verify`.

## Usage

Core flow:

1. Initialize an existing repository:

   ```powershell
   npm exec -- mwt init --base main --remote origin
   ```

2. Create a task worktree:

   ```powershell
   npm exec -- mwt create feature-auth
   ```

3. Work and commit inside the task worktree, then deliver:

   ```powershell
   npm exec -- mwt deliver feature-auth --target main
   ```

4. Prune delivered worktrees:

   ```powershell
   npm exec -- mwt prune --merged --with-branches
   ```

End-to-end example:

```powershell
npm exec -- mwt init --base main --remote origin
npm exec -- mwt create feature-auth
npm exec -- mwt list --kind task --status active --json
npm exec -- mwt deliver feature-auth --target main
npm exec -- mwt sync --base main
npm exec -- mwt prune --merged --with-branches
npm exec -- mwt doctor --fix
```

### Commands

#### `mwt init`

Initialize the current repository for managed worktree operation.

Parameters:

- `--base <branch>`: default target branch recorded in `.mwt/config.toml`.
- `--remote <name>`: default remote recorded in `.mwt/config.toml`.
- `--force`: allow initialization even when tracked files are already dirty.

Example:

```powershell
npm exec -- mwt init --base main --remote origin --json
```

#### `mwt create <name>`

Create a sibling task worktree and branch from the configured remote base.

Parameters:

- `<name>`: task worktree name.
- `--name <name>`: alias for the positional worktree name.
- `--base <branch>`: override the configured base branch for this worktree.
- `--copy-profile <profile>`: choose a bootstrap copy profile from `.mwt/config.toml`.
- `--run-bootstrap`: keep bootstrap enabled explicitly.
- `--no-bootstrap`: skip copying allowlisted ignored files such as `.env.local`.

Example:

```powershell
npm exec -- mwt create feature-auth --base main --copy-profile local
```

#### `mwt list`

List the seed worktree and managed task worktrees.

Parameters:

- `--all`: accepted for automation compatibility.
- `--kind <seed|task>`: filter by worktree kind.
- `--status <active|delivered|conflict|abandoned|healthy>`: filter by managed status.

Example:

```powershell
npm exec -- mwt list --kind task --status active --json
```

#### `mwt deliver [<name>]`

Rebase a task worktree onto the remote target branch, run verification, push, and sync the seed worktree.

Parameters:

- `<name>`: task worktree name or worktree id. If omitted, the current task worktree is used.
- `--target <branch>`: override the configured delivery target branch.
- `--keep`: accepted for forward compatibility. Current behavior already keeps the task worktree after delivery.
- `--allow-dirty-task`: skip the pre-deliver tracked-clean task check.
- `--resume`: rerun delivery after a previously recorded conflict or interruption.

Example:

```powershell
npm exec -- mwt deliver feature-auth --target main --json
```

#### `mwt sync`

Fast-forward the seed worktree to the configured remote branch.

Parameters:

- `--base <branch>`: override the configured branch for this sync.
- `--force-fetch`: accepted for forward compatibility. Current behavior always fetches before syncing.

Example:

```powershell
npm exec -- mwt sync --base main
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
npm exec -- mwt prune --merged --with-branches --json
```

#### `mwt doctor`

Validate managed metadata and optionally repair registry drift.

Parameters:

- `--fix`: repair missing or stale registry entries when possible.
- `--deep`: accepted for forward compatibility.

Example:

```powershell
npm exec -- mwt doctor --fix --json
```

#### `mwt version`

Print the CLI version.

Example:

```powershell
npm exec -- mwt version
```

### Global flags

- `--json`: emit a single JSON envelope on stdout.
- `--output <path>`: also write the JSON envelope to a file.
- `--dry-run`: return a non-mutating preview envelope for commands that support preview mode.
- `--yes`: approve hook execution or other guarded automation steps.
- `--quiet`: suppress human-readable stderr summaries.
- `--verbose` or `-v`: reserve verbose logging for future expansion.
- `--help` or `-h`: show help for the top-level CLI or a specific command.
- `--version` or `-V`: print the CLI version.

## Development commands

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run verify`
- `npm run format`

## Environment variables

- None required.

## Release / deploy

- Not applicable yet. The repository currently produces a local CLI surface rather than a published release artifact.

## Links

- [Managed Worktree System Design](docs/managed-worktree-system-design.md)
- [Managed Worktree System Implementation Spec v1](docs/managed-worktree-system-implementation-spec-v1.md)
- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE)
