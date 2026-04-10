import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { pathExists } from '../src/lib/fs.mjs';
import { MWT_MARKER_FILE } from '../src/lib/constants.mjs';
import {
  cliPath,
  createRepoWithRemote,
  readJson,
  run,
  runCli,
  runGit,
  waitForPath,
} from './helpers.mjs';

test('mwt init creates bare-backed managed layout and doctor passes', async () => {
  const fixture = await createRepoWithRemote();

  const initResult = await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const initJson = JSON.parse(initResult.stdout);
  assert.equal(initJson.ok, true);
  assert.equal(await pathExists(path.join(fixture.repoDir, '.bare')), true);
  assert.equal(await pathExists(path.join(fixture.repoDir, '.mwt', 'config.toml')), true);
  assert.equal(await pathExists(path.join(fixture.repoDir, MWT_MARKER_FILE)), true);

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(doctorJson.result.issues.length, 0);
});

test('mwt create makes sibling task worktree and copies allowlisted ignored bootstrap files', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const createResult = await runCli(fixture.repoDir, ['create', 'feature-auth', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;
  assert.equal(await pathExists(path.join(taskPath, MWT_MARKER_FILE)), true);
  assert.equal(await pathExists(path.join(taskPath, '.env.local')), true);

  const envContent = await readFile(path.join(taskPath, '.env.local'), 'utf8');
  assert.equal(envContent, 'TOKEN=seed\n');

  const listResult = await runCli(fixture.repoDir, ['list', '--json']);
  const listJson = JSON.parse(listResult.stdout);
  assert.equal(listJson.result.items.some((item) => item.kind === 'seed'), true);
  assert.equal(listJson.result.items.some((item) => item.kind === 'task'), true);
});

test('mwt sync fails on dirty seed and fast-forwards clean seed after remote update', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  await writeFile(path.join(fixture.repoDir, 'README.md'), '# Dirty\n', 'utf8');
  const dirtySync = await runCli(fixture.repoDir, ['sync', '--json'], 4);
  const dirtyJson = JSON.parse(dirtySync.stdout);
  assert.equal(dirtyJson.error.id, 'seed_tracked_dirty');

  await runGit(fixture.repoDir, ['checkout', '--', 'README.md']);
  await writeFile(path.join(fixture.updateDir, 'README.md'), '# Updated remotely\n', 'utf8');
  await runGit(fixture.updateDir, ['add', 'README.md']);
  await runGit(fixture.updateDir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'remote update']);
  await runGit(fixture.updateDir, ['push', 'origin', 'main']);

  const syncResult = await runCli(fixture.repoDir, ['sync', '--json']);
  const syncJson = JSON.parse(syncResult.stdout);
  assert.equal(syncJson.ok, true);

  const readme = await readFile(path.join(fixture.repoDir, 'README.md'), 'utf8');
  assert.equal(readme, '# Updated remotely\n');
});

test('mwt deliver pushes committed task changes and prune removes delivered worktree', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'ship-it', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;

  await writeFile(path.join(taskPath, 'README.md'), '# Delivered\n', 'utf8');
  await runGit(taskPath, ['add', 'README.md']);
  await runGit(taskPath, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'task change']);

  const deliverResult = await runCli(fixture.repoDir, ['deliver', 'ship-it', '--json']);
  const deliverJson = JSON.parse(deliverResult.stdout);
  assert.equal(deliverJson.ok, true);

  const seedReadme = await readFile(path.join(fixture.repoDir, 'README.md'), 'utf8');
  assert.equal(seedReadme, '# Delivered\n');

  await runGit(fixture.updateDir, ['pull', '--ff-only', 'origin', 'main']);
  const remoteReadme = await readFile(path.join(fixture.updateDir, 'README.md'), 'utf8');
  assert.equal(remoteReadme, '# Delivered\n');

  const pruneResult = await runCli(fixture.repoDir, ['prune', '--merged', '--with-branches', '--json']);
  const pruneJson = JSON.parse(pruneResult.stdout);
  assert.equal(pruneJson.result.pruned.length, 1);
  assert.equal(await pathExists(taskPath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);
});

test('mwt doctor --fix rebuilds a missing worktree registry entry', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'registry-fix', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;
  const marker = await readJson(path.join(taskPath, MWT_MARKER_FILE));

  await writeFile(
    path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'),
    JSON.stringify({ version: 1, items: [] }, null, 2),
    'utf8',
  );

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--fix', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(doctorJson.result.actions.some((action) => action.worktreeId === marker.worktreeId), true);
});

test('mwt doctor --deep --fix clears expired lock files', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const lockPath = path.join(fixture.repoDir, '.mwt', 'state', 'locks', 'stale-task.json');
  await writeFile(lockPath, JSON.stringify({
    version: 1,
    scope: 'stale-task',
    token: 'expired-token',
    seedRoot: fixture.repoDir.replaceAll('\\', '/'),
    command: 'create',
    pid: 1234,
    host: 'fixture-host',
    acquiredAt: '2026-04-10T00:00:00.000Z',
    expiresAt: '2026-04-10T00:05:00.000Z',
  }, null, 2), 'utf8');

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--deep', '--fix', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(doctorJson.result.actions.some((action) => action.id === 'clear_expired_lock'), true);
  assert.equal(await pathExists(lockPath), false);
});

test('mwt create --dry-run returns a creation plan without mutating the repository', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const dryRunResult = await runCli(fixture.repoDir, ['create', 'preview-task', '--dry-run', '--json']);
  const dryRunJson = JSON.parse(dryRunResult.stdout);
  assert.equal(dryRunJson.result.dryRun, true);
  assert.equal(dryRunJson.result.actions.some((action) => action.id === 'add_worktree'), true);
  assert.equal(await pathExists(dryRunJson.result.worktreePath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);
});

test('mwt create --run-bootstrap overrides a disabled bootstrap config', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const configPath = path.join(fixture.repoDir, '.mwt', 'config.toml');
  const currentConfig = await readFile(configPath, 'utf8');
  await writeFile(configPath, currentConfig.replace('enabled = true', 'enabled = false'), 'utf8');

  const withoutOverride = await runCli(fixture.repoDir, ['create', 'no-bootstrap-default', '--json']);
  const withoutOverrideJson = JSON.parse(withoutOverride.stdout);
  assert.equal(await pathExists(path.join(withoutOverrideJson.result.worktreePath, '.env.local')), false);

  const withOverride = await runCli(fixture.repoDir, ['create', 'with-bootstrap', '--run-bootstrap', '--json']);
  const withOverrideJson = JSON.parse(withOverride.stdout);
  assert.equal(await pathExists(path.join(withOverrideJson.result.worktreePath, '.env.local')), true);
});

test('mwt list hides external worktrees by default and includes them with --all', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const externalPath = path.join(fixture.rootDir, 'external-worktree');
  await runGit(fixture.repoDir, ['worktree', 'add', externalPath, '-b', 'external-branch', 'origin/main']);

  const defaultList = JSON.parse((await runCli(fixture.repoDir, ['list', '--json'])).stdout);
  assert.equal(defaultList.result.items.some((item) => item.kind === 'external'), false);

  const allList = JSON.parse((await runCli(fixture.repoDir, ['list', '--all', '--json'])).stdout);
  assert.equal(allList.result.items.some((item) => item.kind === 'external'), true);
});

test('mwt blocks concurrent state-changing operations with a repository lock', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const hookPath = path.join(fixture.repoDir, '.mwt', 'hooks', 'hold-lock.cjs');
  await writeFile(hookPath, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.MWT_LOCK_READY, 'ready');",
    'const deadline = Date.now() + 10000;',
    'while (!fs.existsSync(process.env.MWT_RELEASE_FILE) && Date.now() < deadline) {}',
  ].join('\n'), 'utf8');

  const configPath = path.join(fixture.repoDir, '.mwt', 'config.toml');
  const currentConfig = await readFile(configPath, 'utf8');
  await writeFile(configPath, `${currentConfig}\n[hooks.pre_create]\nhold_lock = "node .mwt/hooks/hold-lock.cjs"\n`, 'utf8');

  const readyPath = path.join(fixture.rootDir, 'lock-ready.txt');
  const releasePath = path.join(fixture.rootDir, 'lock-release.txt');
  const env = {
    ...process.env,
    MWT_LOCK_READY: readyPath,
    MWT_RELEASE_FILE: releasePath,
  };

  const firstCreate = run(process.execPath, [cliPath, 'create', 'locked-first', '--yes', '--json'], {
    cwd: fixture.repoDir,
    env,
  });
  await waitForPath(readyPath);

  const secondCreate = await runCli(
    fixture.repoDir,
    ['create', 'locked-second', '--json'],
    13,
  );
  const secondJson = JSON.parse(secondCreate.stdout);
  assert.equal(secondJson.error.id, 'operation_locked');

  await writeFile(releasePath, 'release\n', 'utf8');
  const firstResult = await firstCreate;
  assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
});
