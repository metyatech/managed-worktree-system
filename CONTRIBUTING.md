# Contributing

## Scope

This repository is the canonical home for the `mwt` CLI and its design, implementation, and release process.

## Development flow

1. Create an isolated branch for each change.
2. Run `npm install`.
3. Run `npm run verify` before committing.
4. Keep documentation and behavior aligned in the same change set.
5. If a change affects CLI behavior, update `README.md` and any affected docs in `docs/` or `OPERATIONS.md`.

## Pull requests

- Keep changes focused.
- Include verification evidence.
- Update the design or implementation spec when the architecture changes.
- Describe release impact when the package version, metadata, or publish process changes.

## SemVer

- Use a major release for backward-incompatible CLI, JSON, or on-disk contract changes.
- Use a minor release for backward-compatible features or new policy enforcement.
- Use a patch release for backward-compatible fixes and documentation-only corrections.

## Release checklist

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run `npm run verify`.
3. Push the release commit to `main`.
4. Create a Git tag that matches the package version.
5. Create a GitHub Release.
6. Run `npm publish`.
7. Verify the published package with `npm view`, `npx`, and `npm install -g`.
