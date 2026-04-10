# Managed Worktree System

`managed-worktree-system` is the dedicated repository for the design and future implementation of a policy-driven Git worktree system for parallel human and AI work.

The current repository baseline is **design-first**. It contains the initial architecture, verification setup for the documentation/configuration surface, and the bootstrap required for future implementation work.

## Purpose

- define a managed-worktree topology that keeps a repository root clean and current
- support human and AI task work in isolated sibling worktrees
- preserve repository-relative filesystem topology such as `../shared-repo`
- make delivery explicit: rebase, verify, push, sync, and cleanup

## Supported environments

- Windows PowerShell is the currently verified operator environment for the reference research
- the architecture itself is intended to remain cross-platform where Git behavior permits

## Setup

1. Install Node.js 22 or later.
2. Run `npm install`.
3. Run `npm run verify`.

## Usage

Current primary artifact:

- [Managed Worktree System Design](docs/managed-worktree-system-design.md)
- [Managed Worktree System Implementation Spec v1](docs/managed-worktree-system-implementation-spec-v1.md)

Planned future surface:

- `mwt init`
- `mwt create`
- `mwt list`
- `mwt deliver`
- `mwt sync`
- `mwt prune`
- `mwt doctor`

## Development commands

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run verify`
- `npm run format`

## Environment variables

- None required at this stage.

## Release / deploy

- Not applicable yet. This repository currently holds design and bootstrap material rather than a published tool.

## Links

- [Managed Worktree System Design](docs/managed-worktree-system-design.md)
- [Managed Worktree System Implementation Spec v1](docs/managed-worktree-system-implementation-spec-v1.md)
- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE)
