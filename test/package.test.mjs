import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runProcess } from '../src/lib/process.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('npm pack --dry-run includes only installable CLI files', async () => {
  const npmExecPath = process.env.npm_execpath;
  assert.equal(typeof npmExecPath, 'string');

  const result = await runProcess(process.execPath, [npmExecPath, 'pack', '--json', '--dry-run'], {
    cwd: projectRoot,
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const [packInfo] = JSON.parse(result.stdout);
  const packedPaths = packInfo.files.map((entry) => entry.path).sort();

  assert.equal(packedPaths.includes('src/cli.mjs'), true);
  assert.equal(packedPaths.includes('src/lib/repo.mjs'), true);
  assert.equal(packedPaths.includes('README.md'), true);
  assert.equal(packedPaths.includes('LICENSE'), true);

  const forbiddenPrefixes = ['test/', '.github/'];
  const forbiddenFiles = new Set([
    '.tasks.jsonl',
    'AGENTS.md',
    'CLAUDE.md',
    'agent-ruleset.json',
    'eslint.config.mjs',
  ]);

  for (const packedPath of packedPaths) {
    assert.equal(forbiddenFiles.has(packedPath), false, `unexpected packed file: ${packedPath}`);
    assert.equal(
      forbiddenPrefixes.some((prefix) => packedPath.startsWith(prefix)),
      false,
      `unexpected packed path: ${packedPath}`,
    );
  }

  assert.equal(packInfo.filename.endsWith('.tgz'), true);
});
