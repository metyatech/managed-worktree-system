import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { pathExists, readText } from '../src/lib/fs.mjs';
import { runProcess } from '../src/lib/process.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const cliPath = path.join(projectRoot, 'src', 'cli.mjs');

export async function run(file, args, options = {}) {
  const result = await runProcess(file, args, options);
  return {
    ...result,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export async function runGit(cwd, args, check = true) {
  const result = await run('git', args, { cwd });
  if (check) {
    assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function runCli(cwd, args, expectCode = 0, options = {}) {
  const result = await run(process.execPath, [cliPath, ...args], {
    cwd,
    env: options.env,
  });
  assert.equal(result.code, expectCode, result.stderr || result.stdout);
  return result;
}

export async function createTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function createRepoWithRemote() {
  const rootDir = await createTempDir('mwt-fixture');
  const remoteDir = path.join(rootDir, 'remote.git');
  const repoDir = path.join(rootDir, 'repo');
  const updateDir = path.join(rootDir, 'update');

  await mkdir(repoDir, { recursive: true });
  await runGit(rootDir, ['init', '--bare', remoteDir]);
  await runGit(repoDir, ['init', '-b', 'main']);
  await writeFile(path.join(repoDir, '.gitignore'), '.env.local\n', 'utf8');
  await writeFile(path.join(repoDir, '.env.local'), 'TOKEN=seed\n', 'utf8');
  await writeFile(path.join(repoDir, 'README.md'), '# Fixture\n', 'utf8');
  await writeFile(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'fixture-repo',
    private: true,
    scripts: {
      verify: 'node --eval "process.exit(0)"',
    },
  }, null, 2), 'utf8');

  await runGit(repoDir, ['add', '.']);
  await runGit(repoDir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'init']);
  await runGit(repoDir, ['remote', 'add', 'origin', remoteDir]);
  await runGit(repoDir, ['push', '-u', 'origin', 'main']);
  await runGit(rootDir, ['clone', remoteDir, updateDir]);
  return {
    rootDir,
    remoteDir,
    repoDir,
    updateDir,
  };
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function waitForPath(targetPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(targetPath)) {
      return true;
    }

    await delay(50);
  }

  throw new Error(`Timed out waiting for path: ${targetPath}`);
}

export async function readFileText(filePath) {
  return readText(filePath);
}
