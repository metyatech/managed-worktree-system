import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readText } from '../src/lib/fs.mjs';
import { runProcess } from '../src/lib/process.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('package metadata is ready for publication', async () => {
  const packageJson = JSON.parse(
    await readText(path.join(projectRoot, 'package.json')),
  );

  assert.equal(packageJson.name, '@metyatech/managed-worktree-system');
  assert.equal(packageJson.version, '1.0.0');
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.equal(
    packageJson.repository?.url,
    'git+https://github.com/metyatech/managed-worktree-system.git',
  );
  assert.equal(
    packageJson.bugs?.url,
    'https://github.com/metyatech/managed-worktree-system/issues',
  );
  assert.equal(
    packageJson.homepage,
    'https://github.com/metyatech/managed-worktree-system#readme',
  );
});

test('npm pack --dry-run includes only installable CLI files', async () => {
  const npmExecPath = process.env.npm_execpath;
  assert.equal(typeof npmExecPath, 'string');

  const result = await runProcess(
    process.execPath,
    [npmExecPath, 'pack', '--json', '--dry-run'],
    {
      cwd: projectRoot,
    },
  );

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
    '.prettierrc.json',
  ]);

  for (const packedPath of packedPaths) {
    assert.equal(
      forbiddenFiles.has(packedPath),
      false,
      `unexpected packed file: ${packedPath}`,
    );
    assert.equal(
      forbiddenPrefixes.some((prefix) => packedPath.startsWith(prefix)),
      false,
      `unexpected packed path: ${packedPath}`,
    );
  }

  assert.equal(packInfo.filename.endsWith('.tgz'), true);
});

test('packed tarball exposes the mwt executable', async () => {
  const npmExecPath = process.env.npm_execpath;
  assert.equal(typeof npmExecPath, 'string');

  const packDir = await mkdtemp(path.join(os.tmpdir(), 'mwt-pack-'));
  const packResult = await runProcess(
    process.execPath,
    [npmExecPath, 'pack', '--pack-destination', packDir],
    {
      cwd: projectRoot,
    },
  );
  assert.equal(packResult.code, 0, packResult.stderr || packResult.stdout);

  const tarballName = packResult.stdout.trim().split(/\r?\n/u).at(-1);
  assert.equal(
    Boolean(tarballName),
    true,
    packResult.stderr || packResult.stdout,
  );

  const execResult = await runProcess(
    process.execPath,
    [
      npmExecPath,
      'exec',
      '--yes',
      '--package',
      path.join(packDir, tarballName),
      '--',
      'mwt',
      '--version',
    ],
    {
      cwd: projectRoot,
    },
  );

  assert.equal(execResult.code, 0, execResult.stderr || execResult.stdout);
  assert.match(execResult.stdout.trim(), /^1\.0\.0$/u);
});
