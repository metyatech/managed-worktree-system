import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathExists, readText } from '../src/lib/fs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('required documentation files exist', async () => {
  const requiredFiles = [
    'agent-ruleset.json',
    'README.md',
    'OPERATIONS.md',
    'CODE_OF_CONDUCT.md',
    '.github/workflows/ci.yml',
    '.github/workflows/publish.yml',
    '.github/workflows/codeql.yml',
    '.github/dependabot.yml',
    'docs/managed-worktree-system-design.md',
    'docs/managed-worktree-system-implementation-spec-v1.md',
    '.github/ISSUE_TEMPLATE/bug-report.yml',
    '.github/ISSUE_TEMPLATE/feature-request.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    'LICENSE',
  ];

  for (const file of requiredFiles) {
    assert.equal(
      await pathExists(path.join(root, file)),
      true,
      `Missing required file: ${file}`,
    );
  }
});

test('README links to both design documents', async () => {
  const readme = await readText(path.join(root, 'README.md'));
  assert.match(readme, /docs\/managed-worktree-system-design\.md/u);
  assert.match(
    readme,
    /docs\/managed-worktree-system-implementation-spec-v1\.md/u,
  );
  assert.match(readme, /OPERATIONS\.md/u);
  assert.match(readme, /CODE_OF_CONDUCT\.md/u);
});
