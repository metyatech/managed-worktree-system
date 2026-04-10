# Managed Worktree System Implementation Spec v1

**Conclusion first:** `managed-worktree-system` v1 should be implemented as a **single CLI policy layer over Git** with a **bare-backed seed worktree**, **named sibling task worktrees**, **explicit JSON output**, and **strict seed cleanliness enforcement**. The system should copy only allowlisted ignored bootstrap files, stop explicitly on conflicts or policy violations, and deliver directly from the task worktree to the remote target branch before fast-forwarding the seed worktree.

This document is the **implementation-level companion** to [Managed Worktree System Design](managed-worktree-system-design.md). The design document explains the architecture. This specification defines the concrete contracts needed to start implementation without inventing behavior ad hoc.

## Scope

This spec covers v1 of the CLI and on-disk contract:

- CLI commands and flags
- exit code registry
- JSON output shapes
- on-disk config and marker schemas
- state machine and state files
- `init`, `create`, `deliver`, `sync`, `prune`, and `doctor` behavior
- hook and bootstrap contracts
- migration rules for existing repositories

This spec does **not** define:

- a custom GUI
- server mode
- distributed locking across multiple hosts
- automatic merge-conflict resolution
- background daemons
- multi-host distributed locking

## Reference-Derived Constraints

### Constraints learned from Worktrunk

Worktrunk is strongest where we need **operator ergonomics**:

- `wt switch` is a strong model for `create`-time lifecycle and JSON-capable automation.
- `wt hook` is a strong model for hook timing, approval, and pre-vs-post separation.
- `wt merge` is a strong model for progressive validation before integration.
- `wt step copy-ignored` is a strong model for allowlisted ignored-file bootstrap.
- `worktree-path` templating is a strong model for sibling worktree path calculation.

Constraints we intentionally keep:

- blocking `pre-*` work vs background `post-*` work
- explicit `--yes`
- structured JSON output
- no silent fallback when hooks or validation fail

Constraints we intentionally reject:

- local-target merge as the terminal deliver action
- treating the visible root as a mutable everyday editing surface
- broad default copying of all ignored files

### Constraints learned from gh-worktree

`gh-worktree` is strongest where we need **topology**:

- bare repo as the Git source of truth
- root `.git` pointer to `.bare/`
- project-local hooks and templates
- checksum-gated executable hooks

Constraints we intentionally keep:

- bare-backed repository layout
- project-local bootstrap and hook directories
- explicit lifecycle points around create/remove

Constraints we intentionally reject:

- hard dependency on `gh`
- GitHub PR checkout as a core v1 feature
- Linux-first assumptions in the operator path

## Normative Summary

v1 MUST satisfy these invariants:

- one canonical Git store: `.bare/`
- one seed worktree: repository root
- all tracked edits happen only in task worktrees
- task worktrees are siblings of the seed worktree
- seed worktree tracked changes block `create`, `deliver`, and `sync`
- task delivery rebases onto the remote target, verifies, pushes, then fast-forwards the seed
- cleanup deletes only managed task worktrees, never the seed worktree
- all state-changing commands support `--json`, `--dry-run`, and non-interactive operation

## Terminology

- **Canonical store**: the bare Git repository at `.bare/`
- **Seed worktree**: the visible repository root
- **Task worktree**: a managed sibling worktree created for human or AI task work
- **Managed worktree**: either the seed or a task worktree with a valid `.mwt-worktree.json`
- **Bootstrap copy**: copying allowlisted ignored files from the seed worktree into a task worktree
- **Deliver**: rebase, verify, push to remote target, sync seed, record result

## CLI Surface

The executable name is `mwt`.

### Commands

- `mwt init`
- `mwt create <name>`
- `mwt list`
- `mwt deliver [<name>]`
- `mwt sync`
- `mwt prune`
- `mwt doctor`
- `mwt version`

### Global flags

All state-changing commands MUST support:

- `--json`
- `--dry-run`
- `--yes`
- `--quiet`
- `--verbose`

All commands SHOULD support:

- `--output <path>`

`--output` writes the same structured result that would otherwise go to stdout in JSON mode. Human-readable logs still go to stderr.

### Command-specific flags

#### `mwt init`

- `--base <branch>`
- `--remote <name>`
- `--force`

#### `mwt create`

- `--base <branch>`
- `--name <name>`
- `--copy-profile <profile>`
- `--run-bootstrap`
- `--no-bootstrap`

`<name>` and `--name` are aliases; one of them is required.

#### `mwt list`

- `--all`
- `--kind <seed|task>`
- `--status <active|delivered|conflict|abandoned>`

#### `mwt deliver`

- `--target <branch>`
- `--allow-dirty-task`
- `--resume`

If `<name>` is omitted, `deliver` operates on the current worktree.

#### `mwt sync`

- `--base <branch>`

#### `mwt prune`

- `--merged`
- `--abandoned`
- `--force`
- `--with-branches`

#### `mwt doctor`

- `--fix`
- `--deep`

## Exit Codes

Exit codes MUST be deterministic across commands.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure |
| `2` | Invalid CLI usage or validation of CLI arguments failed |
| `3` | Repository is not initialized for managed-worktree-system |
| `4` | Seed worktree policy violation |
| `5` | Task worktree policy violation |
| `6` | Hook failure |
| `7` | Verification failure |
| `8` | Git conflict during rebase or merge-like operation |
| `9` | Remote push rejected or remote sync failure |
| `10` | Requested managed worktree not found |
| `11` | Unsafe prune target |
| `12` | Unsupported repository state during `init` migration |
| `13` | Another managed-worktree operation is already holding the repository lock |

## Output Contract

### Human-readable mode

- progress logs go to stderr
- final summary goes to stderr
- stdout stays reserved for command results that are intentionally pipeable

### JSON mode

Every command MUST emit a single JSON object with this envelope:

```json
{
  "ok": true,
  "command": "create",
  "timestamp": "2026-04-10T12:00:00.000Z",
  "repoRoot": "D:/ghws/example-repo",
  "code": 0,
  "result": {}
}
```

Error responses use the same envelope:

```json
{
  "ok": false,
  "command": "sync",
  "timestamp": "2026-04-10T12:00:00.000Z",
  "repoRoot": "D:/ghws/example-repo",
  "code": 4,
  "error": {
    "id": "seed_tracked_dirty",
    "message": "Seed worktree has tracked changes and cannot be synchronized.",
    "details": {
      "changedFiles": [
        "README.md"
      ],
      "recovery": "Move tracked edits into a task worktree or discard them, then rerun mwt sync."
    }
  }
}
```

## On-Disk Layout

```text
repo-root/
  .bare/
  .git
  .mwt/
    config.toml
    hooks/
    templates/
    state/
      locks/
      seed.json
      worktrees.json
      last-deliver.json
      last-sync.json
    logs/
  .mwt-worktree.json
```

Task worktrees live next to `repo-root/` and contain only:

- a normal Git worktree
- `.mwt-worktree.json`

Task worktrees MUST NOT contain their own `.mwt/` directory.

## Schema: `.mwt/config.toml`

This file is versioned and shared.

```toml
version = 1
default_branch = "main"
default_remote = "origin"
task_worktree_dir_template = "{{ seed_parent }}/{{ repo }}-wt-{{ slug }}-{{ shortid }}"
task_branch_template = "wt/{{ slug }}/{{ shortid }}"

[bootstrap]
enabled = true
default_profile = "local"

[bootstrap.profiles.local]
include = [".env", ".env.local", ".env.*.local"]
exclude = ["node_modules/", ".venv/", ".next/", "dist/"]

[hooks.pre_create]
ensure_seed_clean = "mwt internal hook ensure-seed-clean"

[hooks.post_create]
copy_bootstrap = "mwt internal hook copy-bootstrap"

[verify]
command = "npm run verify"

[policy]
allow_ignored_seed_changes = true
allow_tracked_seed_changes = false
```

Required top-level keys:

- `version`
- `default_branch`
- `default_remote`
- `task_worktree_dir_template`
- `task_branch_template`
- `bootstrap`
- `policy`

## Schema: `.mwt-worktree.json`

This file exists in every managed worktree.

### Seed worktree marker

```json
{
  "version": 1,
  "kind": "seed",
  "repoId": "metyatech/managed-worktree-system",
  "repoRoot": "D:/ghws/managed-worktree-system",
  "bareGitDir": "D:/ghws/managed-worktree-system/.bare",
  "defaultBranch": "main",
  "defaultRemote": "origin"
}
```

### Task worktree marker

```json
{
  "version": 1,
  "kind": "task",
  "repoId": "metyatech/managed-worktree-system",
  "repoRoot": "D:/ghws/managed-worktree-system",
  "worktreeName": "feat-bootstrap",
  "worktreeSlug": "feat-bootstrap",
  "worktreeId": "a1b2c3d4",
  "worktreePath": "D:/ghws/managed-worktree-system-wt-feat-bootstrap-a1b2c3d4",
  "branch": "wt/feat-bootstrap/a1b2c3d4",
  "baseBranch": "main",
  "targetBranch": "main",
  "createdAt": "2026-04-10T12:00:00.000Z",
  "createdBy": "human"
}
```

Required keys for task worktrees:

- `version`
- `kind`
- `repoId`
- `repoRoot`
- `worktreeName`
- `worktreeSlug`
- `worktreeId`
- `worktreePath`
- `branch`
- `baseBranch`
- `targetBranch`
- `createdAt`

## State Files

Ignored runtime state lives under `.mwt/state/`.

### `seed.json`

Tracks seed invariants:

```json
{
  "version": 1,
  "branch": "main",
  "remote": "origin",
  "lastSyncAt": "2026-04-10T12:00:00.000Z",
  "lastSyncCommit": "abc1234",
  "status": "healthy"
}
```

### `worktrees.json`

Tracks the current registry of managed task worktrees:

```json
{
  "version": 1,
  "items": [
    {
      "worktreeId": "a1b2c3d4",
      "name": "feat-bootstrap",
      "branch": "wt/feat-bootstrap/a1b2c3d4",
      "path": "D:/ghws/managed-worktree-system-wt-feat-bootstrap-a1b2c3d4",
      "status": "active"
    }
  ]
}
```

### `last-deliver.json`

Tracks the most recent deliver attempt:

```json
{
  "version": 1,
  "worktreeId": "a1b2c3d4",
  "status": "succeeded",
  "startedAt": "2026-04-10T12:00:00.000Z",
  "finishedAt": "2026-04-10T12:05:00.000Z",
  "targetBranch": "main",
  "pushedCommit": "def5678",
  "seedSyncedTo": "def5678"
}
```

### `last-sync.json`

Tracks the most recent explicit sync:

```json
{
  "version": 1,
  "status": "succeeded",
  "startedAt": "2026-04-10T12:00:00.000Z",
  "finishedAt": "2026-04-10T12:00:30.000Z",
  "branch": "main",
  "before": "abc1234",
  "after": "def5678"
}
```

## Worktree State Machine

Task worktrees use this state model:

- `active`
- `delivering`
- `conflict`
- `delivered`
- `abandoned`
- `pruned`

Allowed transitions:

- `active -> delivering`
- `delivering -> conflict`
- `delivering -> delivered`
- `conflict -> delivering`
- `active -> abandoned`
- `delivered -> pruned`
- `abandoned -> pruned`

There is no silent transition from `conflict` to `delivered`. A human or AI must resolve the conflict and rerun `deliver --resume`.

## Hook Contract

Hooks are defined in `.mwt/config.toml`.

Hook classes:

- `pre_init`
- `post_init`
- `pre_create`
- `post_create`
- `pre_deliver`
- `post_deliver`
- `pre_prune`
- `post_prune`

Rules:

- `pre_*` hooks are blocking
- `post_*` hooks remain blocking in v1 for deterministic CLI completion
- project-local hook commands are resolved from the seed worktree
- project hooks require approval fingerprinting unless `--yes` is supplied
- hook context is passed as JSON on stdin

Hook stdin JSON MUST include:

```json
{
  "version": 1,
  "hookType": "pre_create",
  "repoRoot": "D:/ghws/example",
  "seedPath": "D:/ghws/example",
  "defaultBranch": "main",
  "defaultRemote": "origin",
  "worktree": {
    "kind": "task",
    "name": "feat-bootstrap",
    "slug": "feat-bootstrap",
    "id": "a1b2c3d4",
    "path": "D:/ghws/example-wt-feat-bootstrap-a1b2c3d4",
    "branch": "wt/feat-bootstrap/a1b2c3d4",
    "baseBranch": "main",
    "targetBranch": "main"
  }
}
```

## Bootstrap Copy Contract

Bootstrap copy is intentionally narrower than Worktrunk's default `copy-ignored`.

Rules:

- only ignored files that match the active profile include list are eligible
- excludes always win
- tracked files are never copied
- copy is non-destructive by default
- `--force` is required to overwrite an existing destination file

The default `local` profile is designed for `.env*` and editor-local settings, not caches or dependency trees.

## Detailed Command Semantics

### `mwt init`

Preconditions:

- repository root is a normal Git repository
- no Git rebase/merge/cherry-pick is in progress
- no linked worktree already occupies the root in an unsupported layout

Behavior:

1. Resolve current default branch and remote.
2. Verify root tracked files are clean unless `--force` is supplied.
3. Move the Git dir to `.bare/`.
4. Write a `.git` pointer file that targets `.bare`.
5. Create `.mwt/` directories.
6. Create `.mwt/config.toml` if absent.
7. Create the seed `.mwt-worktree.json`.
8. Create ignored state/log paths and update local Git exclude rules if required.
9. Record `seed.json`.

Failure rule:

- if migration cannot complete atomically, restore the original Git layout and return exit code `12`

### `mwt create`

Preconditions:

- seed marker exists
- current root tracked state is clean
- requested task name passes slug validation

Behavior:

1. Load `.mwt/config.toml`.
2. Fetch `origin/<base>`.
3. Generate `slug` and `shortid`.
4. Render `task_worktree_dir_template`.
5. Refuse creation if the target path is occupied by a non-managed directory.
6. Create branch from `origin/<base>`.
7. Add sibling worktree.
8. Write task marker.
9. Run `pre_create`.
10. Copy bootstrap files if enabled.
11. Run `post_create`.
12. Register the worktree in `worktrees.json`.

### `mwt list`

Behavior:

- enumerate Git worktrees
- enrich with `.mwt-worktree.json` when present
- classify each worktree as `seed`, `task`, or `external`
- omit `external` worktrees unless `--all` is supplied
- report divergence, dirty state, and last-known managed status

### `mwt deliver`

Preconditions:

- current worktree or named target is a managed task worktree
- seed worktree tracked state is clean
- task worktree has no unresolved merge conflicts

Behavior:

1. Load task marker.
2. Set runtime status to `delivering`.
3. Fetch `origin/<target>`.
4. Rebase task branch onto `origin/<target>`.
5. If rebase conflicts, set status `conflict`, persist `last-deliver.json`, and exit `8`.
6. Run `pre_deliver`.
7. Run verify command from config.
8. If verify fails, persist failure and exit `7`.
9. Push `HEAD:<target>` to the configured remote.
10. If push is rejected, persist failure and exit `9`.
11. Fast-forward the seed worktree to `origin/<target>`.
12. If seed sync fails, persist failure and exit `9`.
13. Run `post_deliver`.
14. Mark task status `delivered`.
15. Leave the delivered worktree prunable; cleanup remains an explicit `mwt prune` step.

### `mwt sync`

Behavior:

1. Verify seed marker and config.
2. Refuse sync if tracked seed files are dirty.
3. Fetch the configured remote branch.
4. Fast-forward the seed branch.
5. Update `seed.json` and `last-sync.json`.

### `mwt prune`

Behavior:

1. Load the managed registry.
2. Enumerate only entries with both a valid marker and a path matching the configured pattern.
3. Refuse to prune tracked-dirty worktrees unless `--force` is set.
4. Refuse to prune worktrees with unexpected untracked files unless `--force` is set.
5. Remove the Git worktree with force after safety validation so expected local bootstrap files and `.mwt-worktree.json` do not block cleanup.
6. Remove the directory.
7. Remove the branch only when `--with-branches` is supplied and the branch is fully merged to the target.
8. Mark status `pruned`.

### `mwt doctor`

Behavior:

- verify `.bare/`, `.git`, `.mwt/config.toml`, and the seed marker are coherent
- verify every registered task worktree still exists
- detect stale registry entries
- detect stale directories matching the naming pattern but missing markers
- detect drift between Git worktree list and managed state files
- with `--deep`, detect stale lock files, orphan sibling directories, and seed topology drift

`--fix` may:

- remove stale registry entries
- rebuild `worktrees.json`
- repair missing `seed.json`

`--fix` must not:

- delete task worktree directories
- rewrite branch topology
- modify tracked repository content outside `.mwt/`

## Validation Rules

Validation occurs at four layers:

- CLI argument validation
- precondition validation before state changes
- repo-standard verify command during `deliver`
- post-operation state validation in `doctor`

The verify command source of truth is:

1. `verify.command` in `.mwt/config.toml`
2. otherwise a repository-standard fallback discovered at runtime

v1 SHOULD start with explicit config and avoid heuristic fallback where practical.

## Logging Rules

Human-readable progress logs go to stderr.

`post_*` hook logs and internal operation logs are written under:

- `.mwt/logs/<timestamp>-<command>.log`

Sensitive values from copied `.env*` files MUST NOT be echoed into logs.

## Recovery Rules

### Seed worktree dirty

Return exit code `4` with a recovery message:

- move tracked changes into a task worktree
- commit or discard them
- rerun the blocked command

### Rebase conflict

Return exit code `8` and keep the task worktree as the recovery surface.

The operator resolves conflicts in place, then reruns:

```bash
mwt deliver --resume
```

### Push rejection

Return exit code `9`.

v1 does not auto-loop on push rejection. The caller decides whether to rerun `deliver`, which will fetch and rebase again from the current task worktree.

## Security Rules

- project hooks are approval-gated by checksum
- copied bootstrap files are allowlisted
- tracked files are never rewritten by bootstrap copy
- path rendering must normalize to a sibling of the seed parent directory
- prune requires both marker validation and pattern validation

## Implementation Order

### Milestone 1

- config loader
- marker loader/validator
- path renderer
- `mwt doctor`
- `mwt list`

### Milestone 2

- `mwt init`
- `mwt create`
- bootstrap copy engine
- hook runner

### Milestone 3

- `mwt sync`
- `mwt deliver`
- state machine persistence

### Milestone 4

- `mwt prune`
- `--fix` modes in `doctor`
- shell and editor integration helpers

## Acceptance Criteria

- The spec is detailed enough that a contributor can implement any single command without inventing file formats or exit semantics.
- `mwt init`, `create`, `deliver`, `sync`, `prune`, and `doctor` all have explicit preconditions and result contracts.
- The on-disk contract is narrow, versioned, and machine-readable.
- The v1 behavior is aligned with the architecture doc while remaining implementable on Windows.
