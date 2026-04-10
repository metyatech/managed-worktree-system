# Managed Worktree System Design

**Conclusion first:** build a **thin policy layer on top of Git worktrees**, not a new Git replacement. Use a **bare-backed seed worktree at the repository root**, create **named sibling task worktrees** for all human and AI edits, and use an explicit **deliver pipeline** that rebases, verifies, pushes, and then fast-forwards the seed worktree.

This design is based on a concrete review of **Worktrunk** and **gh-worktree** as of 2026-04-10. The goal is to keep the visible repository root **clean, current, and usable as the bootstrap source**, while still supporting parallel human and AI work safely.

## Goals

- Keep the repository root on its declared base branch and fast-forward it after every successful delivery.
- Prevent human and AI edits in the repository root for tracked files.
- Preserve filesystem-topology assumptions such as `../course-content` by creating task worktrees as **siblings** of the repository root.
- Allow machine-local ignored files such as `.env.local` to live in the repository root and be copied into task worktrees.
- Make task work visible, resumable, and safely cleanable.
- Give both humans and AI a non-interactive, scriptable workflow.

## Non-goals

- Replacing Git, GitHub, or `git worktree`.
- Building a custom GUI in v1.
- Auto-resolving merge conflicts.
- Copying mutable runtime artifacts such as `node_modules/` by default.
- Supporting silent fallback paths when policy enforcement fails.

## Reference Systems Studied

### Worktrunk

Reviewed and probed:

- `wt switch`
- `wt merge`
- `wt hook`
- `wt step copy-ignored`
- project config and hook model

Strong ideas worth adopting:

- project-local config and lifecycle hooks
- non-interactive CLI UX
- allowlisted ignored-file copying
- strong local worktree ergonomics
- per-worktree status and logs

Verified gaps for this project:

- its merge/push flow is **local-target oriented**, not "push to remote and then sync the visible root"
- it does not enforce a "root worktree must stay clean and current" policy
- it assumes a more conventional main-worktree model unless configured carefully

Primary references:

- <https://worktrunk.dev/config/>
- <https://worktrunk.dev/hook/>
- <https://worktrunk.dev/merge/>
- <https://worktrunk.dev/step/>
- <https://worktrunk.dev/switch/>

### gh-worktree

Reviewed and probed:

- `init`
- `create`
- bare-repository layout
- hooks and templates model

Strong ideas worth adopting:

- bare Git storage as the canonical store
- project-local hook and template directories
- clean separation between Git state and working trees

Verified gaps for this project:

- its daily operator workflow is thinner than Worktrunk's
- its documented support is Linux-first even though the basic flow worked in a Windows probe
- it does not provide the deliver policy needed here

Primary reference:

- <https://github.com/bjester/gh-worktree>

## Decision

Adopt the **topology** from gh-worktree and the **operator ergonomics** from Worktrunk, then add a small custom policy layer for the missing invariants:

- remote delivery
- root-worktree cleanliness enforcement
- deterministic fast-forward sync of the root worktree
- safe naming and cleanup of temporary task worktrees
- bootstrap rules for ignored local files

A concrete Windows probe also showed that these choices are not in tension: a **bare-backed repository layout** and **Worktrunk-style day-to-day worktree operations** can coexist. That makes it reasonable to treat the two tools as complementary design inputs rather than competing end states.

## Chosen Architecture

### High-level model

- **Canonical Git store:** a bare repository at `.bare/`
- **Seed worktree:** the visible repository root, on a declared base branch such as `main`
- **Task worktrees:** sibling directories created next to the repository root
- **Delivery model:** deliver from the task worktree itself; do **not** create a second integration worktree in v1
- **Bootstrap source:** ignored local files in the seed worktree, copied by allowlist into task worktrees

### Why the repository root stays visible

The root worktree is still useful:

- humans already know where the repository lives
- machine-local files such as `.env.local` can live there
- relative paths like `../course-content` keep the same meaning when task worktrees are siblings

The bare repository is the canonical Git store, but the root worktree is the canonical **human-visible base**.

## Project Contract

```yaml
version: 1

system:
  name: managed-worktree
  domain: developer-workspace
  summary: >
    A policy-driven Git worktree system for parallel human and AI work.

actors:
  human:
    role: operator
    primary_goal: Start work quickly in isolated task worktrees without dirtying the repository root.
  ai:
    role: delegated implementer
    primary_goal: Create, use, deliver, and clean up isolated task worktrees through a scriptable CLI.

canonical_store:
  kind: bare-git-repository
  location: .bare/
  version_controlled: true

human_surface:
  mode: existing-gui
  kind: terminal-plus-editor-plus-explorer
  startup:
    kind: launcher-plus-cli
  live_diagnostics: true
  diagnostics_delivery: terminal-output-plus-status-files

ai_surface:
  mode: cli
  kind: structured-command-surface
  target: managed-worktree-cli

sync:
  source_of_truth: bare_git_store
  edit_flow:
    human: task_worktree_only
    ai: task_worktree_only
  refresh_flow:
    seed_worktree: fast_forward_after_successful_delivery
  conflict_policy:
    detection: explicit
    resolution: manual
    auto_overwrite: false

validation:
  live:
    enabled: true
    surface: cli-status-and-doctor
  save:
    enabled: true
  build_gate:
    enabled: true

outputs:
  generated_dir: .mwt/
  artifacts:
    - config
    - hooks
    - templates
    - state
    - logs
  gitignored: mixed

gui_selection:
  strategy: native-gui-reuse
  reason: >
    Operators already work in Git, editors, terminals, and Explorer.
    A custom GUI would add surface area without solving the core policy problem.

launch:
  human_entrypoints:
    - managed-worktree-cli
    - optional-shell-aliases
    - optional-explorer-shortcuts
  ai_entrypoint:
    - managed-worktree-cli-with-json

acceptance:
  - The repository root remains on its declared base branch and is fast-forwarded after successful delivery.
  - Humans and AI do not edit tracked files in the repository root.
  - Task worktrees preserve repository-relative filesystem topology by living next to the repository root.
  - Ignored local bootstrap files can be copied from the seed worktree by explicit allowlist.
  - Delivery stops explicitly on conflicts or policy violations; no silent overwrite occurs.
```

## Repository Layout

```text
repo-root/
  .bare/                 # bare Git directory; source of truth for refs and objects
  .git                   # gitdir pointer to .bare
  .mwt/
    config.toml          # versioned project config
    hooks/               # versioned project hook scripts
    templates/           # versioned bootstrap templates
    state/               # ignored runtime state
    logs/                # ignored runtime logs
  .mwt-worktree.json     # marker for the seed worktree
  ...tracked files...
  .env.local             # ignored local bootstrap file
../repo-wt-feature-a/
  .mwt-worktree.json     # marker for a managed task worktree
../repo-wt-bugfix-b/
  .mwt-worktree.json
```

## Naming and Cleanup Rules

Task worktrees must be easy to identify and safe to remove.

- Directory pattern: `<repo-name>-wt-<slug>-<shortid>`
- Branch pattern: `wt/<slug>/<shortid>`
- Marker file: `.mwt-worktree.json`
- Cleanup may remove a worktree **only if both the naming pattern and the marker file match**
- The seed worktree uses its own marker with `"kind": "seed"` and never matches task cleanup rules

This avoids the "cleanup by prefix only" hazard.

## CLI Surface

The system should stay narrow.

- `mwt init`
- `mwt create <name> --base <branch>`
- `mwt list`
- `mwt deliver <name>`
- `mwt sync`
- `mwt prune`
- `mwt doctor`

Required CLI properties:

- fully non-interactive mode
- `--json`
- stable exit codes
- `--yes` for destructive confirmations
- explicit error messages for policy violations

## Core Flows

### `mwt init`

Purpose:

- convert or initialize a repository into the managed topology
- create `.bare/`, `.mwt/`, and marker files
- declare the seed branch
- install hooks and ignore rules

Key rules:

- the repository root becomes the seed worktree
- `.git` becomes a pointer to `.bare`
- ignored runtime state under `.mwt/state/` and `.mwt/logs/` is added to `.gitignore`
- project config stays versioned; runtime state stays ignored

### `mwt create`

Purpose:

- create a new sibling task worktree from the requested base branch
- bootstrap allowed local files and optional setup commands

Flow:

1. Verify the seed worktree is on its declared base branch.
2. Verify the seed worktree has no tracked changes.
3. Fetch the remote base branch.
4. Create a sibling worktree from `origin/<base>`.
5. Write `.mwt-worktree.json` into the new worktree.
6. Copy allowlisted ignored files from the seed worktree.
7. Run project bootstrap hooks.

### `mwt deliver`

Purpose:

- deliver the task branch directly from the task worktree to the remote target branch
- then fast-forward the seed worktree

Flow:

1. Verify the current worktree is a managed task worktree.
2. Verify task worktree metadata matches the requested task.
3. Fetch the remote target branch.
4. Rebase the task branch onto `origin/<target>`.
5. If conflicts occur, stop and leave the task worktree as the conflict-resolution surface.
6. Run project verification commands.
7. Push `HEAD:<target>` to the remote.
8. Fast-forward the seed worktree to `origin/<target>`.
9. Mark delivery success in state files.
10. Optionally prune the task worktree.

This flow intentionally **does not** use a second integration worktree in v1. The task worktree is already isolated, so a separate merge lane adds complexity without protecting the seed worktree further.

### `mwt sync`

Purpose:

- keep the seed worktree current
- detect policy violations early

Flow:

1. Verify the seed worktree is on its declared base branch.
2. Verify the seed worktree has no tracked changes.
3. Fetch the remote branch.
4. Fast-forward the seed worktree.

Important rule:

- `mwt sync` must **fail explicitly** if the seed worktree has tracked changes
- it must not silently skip and claim the repository is healthy

### `mwt prune`

Purpose:

- remove completed or abandoned task worktrees safely

Flow:

1. Enumerate only worktrees with both the managed naming pattern and marker file.
2. Refuse deletion when the task worktree is dirty unless `--force` is given.
3. Remove the Git worktree first, then the directory.
4. Remove the task branch only when explicitly requested and confirmed safe.

## Bootstrap Policy

### Allowed by default

- `.env`
- `.env.local`
- `.env.*.local`
- editor-local ignored settings
- small machine-local bootstrap files explicitly listed by project config

### Not copied by default

- `node_modules/`
- `.venv/`
- build outputs
- cache directories
- database files
- large mutable generated assets

Reason:

`.env`-style files are good bootstrap inputs. Mutable dependency trees and caches are shared-state hazards and should be rebuilt or restored from package-manager caches unless a project explicitly opts in.

## Policy Enforcement

The system should not rely on operator memory alone.

- Every command begins with a seed-worktree policy check.
- The seed worktree may contain ignored local files, but **no tracked changes**.
- Delivery is not considered successful until seed fast-forward sync succeeds.
- If the seed worktree is dirty, the tool returns a policy-violation error and a deterministic rescue path.
- Future hardening may add OS-level read-only protection for tracked files in the seed worktree when practical, but v1 should not depend on platform-specific file attributes.

## State and Diagnostics

Versioned:

- `.mwt/config.toml`
- `.mwt/hooks/`
- `.mwt/templates/`

Ignored:

- `.mwt/state/*.json`
- `.mwt/logs/*.log`

State should record:

- seed branch
- managed worktree name, branch, path, and kind
- bootstrap status
- last verification result
- last delivery result
- last sync result

## What We Reuse vs Build

### Reuse directly

- Git as the authoritative VCS and worktree engine
- existing editor, terminal, and Explorer surfaces
- project-managed verify commands

### Reuse as design references

- Worktrunk hook/config/copy-ignored ergonomics
- gh-worktree bare-backed topology

### Build ourselves

- the root-worktree cleanliness policy
- remote delivery pipeline
- seed fast-forward synchronization
- managed naming, markers, and cleanup safety
- JSON-first AI command surface

## Implementation Phases

### Phase 1

- `mwt init`
- `mwt create`
- `mwt list`
- `mwt doctor`
- seed-worktree policy checks
- allowlisted bootstrap copy

### Phase 2

- `mwt deliver`
- `mwt sync`
- `mwt prune`
- structured state and logs
- conflict and resume states

### Phase 3

- optional shell integration
- optional Explorer shortcuts
- optional stronger seed protection

## Acceptance Criteria

- A repository can be initialized without changing its visible path.
- The repository root remains usable as the bootstrap source for ignored local files.
- A task worktree created from the system preserves `../`-style topology assumptions.
- Humans and AI can create task worktrees without touching tracked files in the seed worktree.
- Delivery rebases onto the remote target, verifies, pushes, and fast-forwards the seed worktree.
- Dirty tracked changes in the seed worktree block sync and delivery with an explicit policy error.
- Cleanup removes only managed temporary worktrees and never the seed worktree.
