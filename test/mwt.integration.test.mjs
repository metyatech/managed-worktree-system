import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { pathExists, removePath } from '../src/lib/fs.mjs';
import { MWT_MARKER_FILE } from '../src/lib/constants.mjs';
import {
  createTaskWorktree,
  doctorRepository,
  deliverTaskWorktree,
  dropTaskWorktree,
  initializeRepository,
  pruneWorktrees,
} from '../src/index.mjs';
import {
  cliPath,
  createTempDir,
  createRepoWithRemote,
  readJson,
  run,
  runCli,
  runGit,
  waitForPath,
} from './helpers.mjs';

async function createLocalSubmoduleRepo(rootDir, repoName = 'rules-submodule') {
  const repoDir = path.join(rootDir, repoName);
  await mkdir(path.join(repoDir, 'rules'), { recursive: true });
  await runGit(repoDir, ['init', '-b', 'main']);
  await writeFile(
    path.join(repoDir, 'rules', 'course-site-metadata.md'),
    '# Private Rules\n',
    'utf8',
  );
  await runGit(repoDir, ['add', '.']);
  await runGit(repoDir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'init submodule']);
  return repoDir;
}

test('mwt init keeps the seed as a normal non-bare repo and doctor passes', async () => {
  const fixture = await createRepoWithRemote();

  const initResult = await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const initJson = JSON.parse(initResult.stdout);
  assert.equal(initJson.ok, true);
  assert.equal(await pathExists(path.join(fixture.repoDir, '.bare')), false);
  assert.equal(await pathExists(path.join(fixture.repoDir, '.git')), true);
  assert.equal(await pathExists(path.join(fixture.repoDir, '.mwt', 'config.toml')), true);
  assert.equal(await pathExists(path.join(fixture.repoDir, MWT_MARKER_FILE)), true);

  const marker = await readJson(path.join(fixture.repoDir, MWT_MARKER_FILE));
  assert.equal('bareGitDir' in marker, false);

  const excludePath = path.join(fixture.repoDir, '.git', 'info', 'exclude');
  const excludeContent = await readFile(excludePath, 'utf8');
  assert.match(excludeContent, /\.mwt-worktree\.json/u);
  assert.match(excludeContent, /\.mwt\/state\//u);
  assert.match(excludeContent, /\.mwt\/logs\//u);

  const seedStatus = await runGit(fixture.repoDir, ['status', '--short']);
  assert.doesNotMatch(seedStatus.stdout, /\.mwt-worktree\.json/u);

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--deep', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(doctorJson.result.issues.length, 0);
});

test('mwt init rejects a linked worktree as the seed', async () => {
  const fixture = await createRepoWithRemote();
  const linkedPath = path.join(fixture.rootDir, 'linked-seed');
  await runGit(fixture.repoDir, ['worktree', 'add', linkedPath, '-b', 'linked-seed']);

  const initResult = await runCli(linkedPath, ['init', '--json'], 12);
  const initJson = JSON.parse(initResult.stdout);
  assert.equal(initJson.error.id, 'init_requires_primary_repo');
});

test('mwt init rejects a bare repository', async () => {
  const rootDir = await createTempDir('mwt-bare-fixture');
  const bareDir = path.join(rootDir, 'repo.git');
  await runGit(rootDir, ['init', '--bare', bareDir]);

  const initResult = await runCli(bareDir, ['init', '--json'], 12);
  const initJson = JSON.parse(initResult.stdout);
  assert.equal(initJson.error.id, 'init_requires_non_bare_repo');
});

test('every CLI subcommand returns command-specific help with -h', async () => {
  const fixture = await createRepoWithRemote();
  const commands = ['init', 'create', 'list', 'deliver', 'sync', 'drop', 'prune', 'doctor', 'version'];

  for (const command of commands) {
    const helpResult = await runCli(fixture.repoDir, [command, '-h']);
    assert.match(helpResult.stdout, new RegExp(`^Usage: mwt ${command}\\b`, 'u'));
    assert.doesNotMatch(helpResult.stdout, /^Commands:/mu);
  }
});

test('mwt version subcommand prints the package version', async () => {
  const fixture = await createRepoWithRemote();
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  const versionResult = await runCli(fixture.repoDir, ['version']);
  assert.equal(versionResult.stdout, packageJson.version);
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

  const taskStatus = await runGit(taskPath, ['status', '--short']);
  assert.doesNotMatch(taskStatus.stdout, /\.mwt-worktree\.json/u);

  const listResult = await runCli(fixture.repoDir, ['list', '--json']);
  const listJson = JSON.parse(listResult.stdout);
  assert.equal(listJson.result.items.some((item) => item.kind === 'seed'), true);
  assert.equal(listJson.result.items.some((item) => item.kind === 'task'), true);
});

test('mwt create initializes submodules in the new task worktree before hooks run', async () => {
  const fixture = await createRepoWithRemote();
  const submoduleRepo = await createLocalSubmoduleRepo(fixture.rootDir);
  await runGit(fixture.repoDir, ['config', 'protocol.file.allow', 'always']);
  await runGit(
    fixture.repoDir,
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'agent-rules-private'],
  );
  await runGit(fixture.repoDir, ['add', '.gitmodules', 'agent-rules-private']);
  await runGit(fixture.repoDir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'add rules submodule']);
  await runGit(fixture.repoDir, ['push', 'origin', 'main']);

  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(
    fixture.repoDir,
    ['create', 'feature-submodule', '--json'],
    0,
    {
      env: {
        GIT_ALLOW_PROTOCOL: 'file',
      },
    },
  );
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;

  assert.equal(
    await pathExists(path.join(taskPath, 'agent-rules-private', 'rules', 'course-site-metadata.md')),
    true,
  );

  const submoduleStatus = await runGit(taskPath, ['submodule', 'status', '--recursive']);
  assert.doesNotMatch(submoduleStatus.stdout, /^-/mu);
});

test('programmatic createTaskWorktree supports manager-specific path, branch, and createdBy overrides', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  const created = await createTaskWorktree(fixture.repoDir, 'assign_q_1234_fix-queue', {
    createdBy: 'manager',
    pathTemplate: '{{ seed_parent }}/{{ repo }}-mgr-{{ slug }}-{{ shortid }}',
    branchTemplate: 'mgr/{{ slug }}/{{ shortid }}',
  });

  assert.match(path.basename(created.worktreePath), /^repo-mgr-assign_q_1234_fix-queue-[0-9a-f]{8}$/u);
  assert.match(created.branch, /^mgr\/assign_q_1234_fix-queue\/[0-9a-f]{8}$/u);

  const marker = await readJson(path.join(created.worktreePath, MWT_MARKER_FILE));
  assert.equal(marker.createdBy, 'manager');
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

test('mwt drop removes an active task worktree and deletes its branch', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'drop-it', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;
  const taskBranch = createJson.result.branch;

  const dropResult = await runCli(fixture.repoDir, ['drop', 'drop-it', '--delete-branch', '--force-branch-delete', '--json']);
  const dropJson = JSON.parse(dropResult.stdout);
  assert.equal(dropJson.ok, true);
  assert.equal(dropJson.result.branchDeleted, true);
  assert.equal(await pathExists(taskPath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', taskBranch]);
  assert.equal(branchCheck.stdout.trim(), '');
});

test('createTaskWorktree rolls back the worktree, directory, branch, and state entry when a post-add step fails', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  // Inject a post_create hook guaranteed to fail. The hook runs AFTER
  // `git worktree add` has already created the directory and the
  // branch, which is exactly the window that used to leave phantom
  // directories behind.
  const configPath = path.join(fixture.repoDir, '.mwt', 'config.toml');
  const originalConfig = await readFile(configPath, 'utf8');
  const withFailingHook = `${originalConfig}

[hooks.post_create]
always_fails = "exit 1"
`;
  await writeFile(configPath, withFailingHook, 'utf8');

  let caught;
  try {
    await createTaskWorktree(fixture.repoDir, 'post-create-failure', {
      yes: true,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'createTaskWorktree should throw when post_create hook fails');
  assert.equal(caught.id, 'hook_failed');

  // The worktree path and branch must be gone: no phantom directories,
  // no ghost branches, no stale state entries.
  const listResult = await runGit(fixture.repoDir, ['worktree', 'list']);
  assert.doesNotMatch(listResult.stdout, /post-create-failure/u);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', '*post-create-failure*']);
  assert.equal(branchCheck.stdout.trim(), '');

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  // The next createTaskWorktree with the same name must succeed
  // (would fail with `worktree_path_occupied` if the directory was
  // left behind).
  await writeFile(configPath, originalConfig, 'utf8');
  const retry = await createTaskWorktree(fixture.repoDir, 'post-create-failure', {
    yes: true,
  });
  assert.equal(await pathExists(retry.worktreePath), true);
});

test('programmatic dropTaskWorktree removes an active manager task worktree and deletes its branch', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });
  const created = await createTaskWorktree(fixture.repoDir, 'drop-manager-task', {
    createdBy: 'manager',
    pathTemplate: '{{ seed_parent }}/{{ repo }}-mgr-{{ slug }}-{{ shortid }}',
    branchTemplate: 'mgr/{{ slug }}/{{ shortid }}',
  });

  const dropped = await dropTaskWorktree(created.worktreePath, {
    force: true,
    deleteBranch: true,
    forceBranchDelete: true,
  });
  assert.equal(dropped.branchDeleted, true);
  assert.equal(await pathExists(created.worktreePath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', created.branch]);
  assert.equal(branchCheck.stdout.trim(), '');
});

test('dropTaskWorktree removes state even when branch deletion fails after the worktree is removed', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });
  const created = await createTaskWorktree(fixture.repoDir, 'drop-branch-failure');

  await writeFile(
    path.join(created.worktreePath, 'README.md'),
    '# Drop Branch Failure\n',
    'utf8',
  );
  await runGit(created.worktreePath, ['add', 'README.md']);
  await runGit(created.worktreePath, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'unique branch change',
  ]);

  let caught = null;
  try {
    await dropTaskWorktree(created.worktreePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: false,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'dropTaskWorktree should report incomplete cleanup');
  assert.equal(caught.id, 'drop_cleanup_incomplete');
  assert.equal(await pathExists(created.worktreePath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', created.branch]);
  assert.match(branchCheck.stdout, new RegExp(created.branch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
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

test('mwt doctor --fix removes an empty stale worktree directory and deletes a stale branch with no unique commits', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'stale-empty', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;
  const taskBranch = createJson.result.branch;

  await runGit(fixture.repoDir, ['worktree', 'remove', taskPath, '--force']);
  await mkdir(taskPath, { recursive: true });

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--fix', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(
    doctorJson.result.actions.some((action) => action.id === 'remove_empty_stale_worktree_dir'),
    true,
  );
  assert.equal(
    doctorJson.result.actions.some((action) => action.id === 'delete_stale_branch' && action.branch === taskBranch),
    true,
  );
  assert.equal(await pathExists(taskPath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', taskBranch]);
  assert.equal(branchCheck.stdout.trim(), '');
});

test('removePath retries transient Windows busy errors before succeeding', async () => {
  const rootDir = await createTempDir('mwt-remove-path-retry');
  const targetPath = path.join(rootDir, 'busy-target');
  await mkdir(path.join(targetPath, 'nested'), { recursive: true });
  await writeFile(path.join(targetPath, 'nested', 'file.txt'), 'busy\n', 'utf8');

  let attempts = 0;
  await removePath(targetPath, {
    platform: 'win32',
    retryDelaysMs: [0, 0],
    waitImpl: async () => {},
    removeImpl: async (nextTargetPath) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error(`EBUSY: resource busy or locked, rmdir '${nextTargetPath}'`);
        error.code = 'EBUSY';
        throw error;
      }

      await rm(nextTargetPath, {
        recursive: true,
        force: true,
      });
    },
  });

  assert.equal(attempts, 3);
  assert.equal(await pathExists(targetPath), false);
});

test('doctorRepository keeps a stale registry entry when path cleanup fails so regular doctor can retry it later', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  const created = await createTaskWorktree(fixture.repoDir, 'doctor-busy-path');
  await runGit(fixture.repoDir, ['worktree', 'remove', created.worktreePath, '--force']);
  await mkdir(created.worktreePath, { recursive: true });

  let caught = null;
  try {
    await doctorRepository(fixture.repoDir, {
      fix: true,
      removePath: async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(created.worktreePath)) {
          const error = new Error(`EBUSY: resource busy or locked, rmdir '${targetPath}'`);
          error.code = 'EBUSY';
          throw error;
        }

        await removePath(targetPath);
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'doctorRepository should surface incomplete cleanup');
  assert.equal(caught.id, 'doctor_fix_incomplete');
  assert.equal(await pathExists(created.worktreePath), true);
  assert.equal(
    caught.details.appliedActions.some(
      (action) =>
        action.id === 'remove_stale_registry_entry' &&
        action.worktreeId === created.worktreeId
    ),
    false,
  );
  assert.equal(
    caught.details.failures.some(
      (failure) =>
        failure.step === 'remove_empty_stale_worktree_dir' &&
        failure.path === created.worktreePath.replaceAll('\\', '/')
    ),
    true,
  );

  let state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].worktreeId, created.worktreeId);

  const retryResult = await runCli(fixture.repoDir, ['doctor', '--fix', '--json']);
  const retryJson = JSON.parse(retryResult.stdout);
  assert.equal(
    retryJson.result.actions.some(
      (action) =>
        action.id === 'remove_stale_registry_entry' &&
        action.worktreeId === created.worktreeId
    ),
    true,
  );
  assert.equal(await pathExists(created.worktreePath), false);

  state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);
});

test('mwt doctor --fix keeps a stale branch when it still has unique commits', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'stale-unique', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;
  const taskBranch = createJson.result.branch;

  await writeFile(path.join(taskPath, 'README.md'), '# Unique stale branch\n', 'utf8');
  await runGit(taskPath, ['add', 'README.md']);
  await runGit(taskPath, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'unique branch change']);

  await runGit(fixture.repoDir, ['worktree', 'remove', taskPath, '--force']);
  await mkdir(taskPath, { recursive: true });

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--fix', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(
    doctorJson.result.actions.some((action) => action.id === 'delete_stale_branch' && action.branch === taskBranch),
    false,
  );
  assert.equal(await pathExists(taskPath), false);

  const branchCheck = await runGit(fixture.repoDir, ['branch', '--list', taskBranch]);
  assert.match(branchCheck.stdout, new RegExp(taskBranch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('doctorRepository reports structured incomplete fix details and continues other stale repairs', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  const blocked = await createTaskWorktree(fixture.repoDir, 'doctor-blocked-branch');
  const clean = await createTaskWorktree(fixture.repoDir, 'doctor-clean-branch');

  await runGit(fixture.repoDir, ['worktree', 'remove', blocked.worktreePath, '--force']);
  await runGit(fixture.repoDir, ['worktree', 'remove', clean.worktreePath, '--force']);
  await mkdir(blocked.worktreePath, { recursive: true });
  await mkdir(clean.worktreePath, { recursive: true });

  const blockingWorktreePath = path.join(fixture.rootDir, 'doctor-blocking-branch-holder');
  await runGit(fixture.repoDir, ['worktree', 'add', blockingWorktreePath, blocked.branch]);

  let caught = null;
  try {
    await doctorRepository(fixture.repoDir, {
      fix: true,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'doctorRepository should report incomplete cleanup details');
  assert.equal(caught.id, 'doctor_fix_incomplete');
  assert.equal(await pathExists(blocked.worktreePath), false);
  assert.equal(await pathExists(clean.worktreePath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const blockedBranchCheck = await runGit(fixture.repoDir, ['branch', '--list', blocked.branch]);
  assert.match(blockedBranchCheck.stdout, new RegExp(blocked.branch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const cleanBranchCheck = await runGit(fixture.repoDir, ['branch', '--list', clean.branch]);
  assert.equal(cleanBranchCheck.stdout.trim(), '');

  assert.equal(
    caught.details.appliedActions.some(
      (action) =>
        action.id === 'remove_stale_registry_entry' &&
        action.worktreeId === blocked.worktreeId
    ),
    true,
  );
  assert.equal(
    caught.details.appliedActions.some(
      (action) =>
        action.id === 'remove_stale_registry_entry' &&
        action.worktreeId === clean.worktreeId
    ),
    true,
  );
  assert.equal(
    caught.details.appliedActions.some(
      (action) =>
        action.id === 'delete_stale_branch' &&
        action.branch === clean.branch
    ),
    true,
  );
  assert.equal(
    caught.details.failures.some(
      (failure) =>
        failure.step === 'delete_stale_branch' &&
        failure.branch === blocked.branch
    ),
    true,
  );
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

test('mwt doctor --deep --fix removes empty orphan sibling directories matching the managed prefix', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);

  const orphanDir = path.join(fixture.rootDir, 'repo-wt-orphan-empty-deadbeef');
  await mkdir(orphanDir, { recursive: true });

  const doctorResult = await runCli(fixture.repoDir, ['doctor', '--deep', '--fix', '--json']);
  const doctorJson = JSON.parse(doctorResult.stdout);
  assert.equal(
    doctorJson.result.actions.some((action) => action.id === 'remove_orphan_sibling_dir'),
    true,
  );
  assert.equal(await pathExists(orphanDir), false);
});

test('pruneWorktrees continues other cleanup after one branch deletion fails', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  const blocked = await createTaskWorktree(fixture.repoDir, 'prune-blocked-branch');
  await writeFile(path.join(blocked.worktreePath, 'blocked.txt'), 'blocked\n', 'utf8');
  await runGit(blocked.worktreePath, ['add', 'blocked.txt']);
  await runGit(blocked.worktreePath, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'blocked branch change',
  ]);
  await deliverTaskWorktree(blocked.worktreePath);
  await runGit(blocked.worktreePath, ['checkout', '--detach']);

  const blockingWorktreePath = path.join(fixture.rootDir, 'blocking-branch-holder');
  await runGit(fixture.repoDir, ['worktree', 'add', blockingWorktreePath, blocked.branch]);

  const clean = await createTaskWorktree(fixture.repoDir, 'prune-clean-branch');
  await writeFile(path.join(clean.worktreePath, 'clean.txt'), 'clean\n', 'utf8');
  await runGit(clean.worktreePath, ['add', 'clean.txt']);
  await runGit(clean.worktreePath, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'clean branch change',
  ]);
  await deliverTaskWorktree(clean.worktreePath);

  let caught = null;
  try {
    await pruneWorktrees(fixture.repoDir, {
      merged: true,
      withBranches: true,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'pruneWorktrees should report incomplete cleanup');
  assert.equal(caught.id, 'prune_cleanup_incomplete');
  assert.equal(await pathExists(blocked.worktreePath), false);
  assert.equal(await pathExists(clean.worktreePath), false);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);

  const blockedBranchCheck = await runGit(fixture.repoDir, ['branch', '--list', blocked.branch]);
  assert.match(blockedBranchCheck.stdout, new RegExp(blocked.branch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const cleanBranchCheck = await runGit(fixture.repoDir, ['branch', '--list', clean.branch]);
  assert.equal(cleanBranchCheck.stdout.trim(), '');
});

test('pruneWorktrees keeps state when path cleanup fails so regular doctor can finish the cleanup later', async () => {
  const fixture = await createRepoWithRemote();
  await initializeRepository(fixture.repoDir, {
    base: 'main',
    remote: 'origin',
  });

  const created = await createTaskWorktree(fixture.repoDir, 'prune-busy-path');
  await writeFile(path.join(created.worktreePath, 'change.txt'), 'cleanup\n', 'utf8');
  await runGit(created.worktreePath, ['add', 'change.txt']);
  await runGit(created.worktreePath, [
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'cleanup change',
  ]);
  await deliverTaskWorktree(created.worktreePath);

  let caught = null;
  try {
    await pruneWorktrees(fixture.repoDir, {
      merged: true,
      withBranches: true,
      removeWorktree: async (seedRoot, worktreePath) => {
        const removeResult = await runGit(seedRoot, ['worktree', 'remove', worktreePath, '--force'], false);
        if (removeResult.code === 0) {
          await mkdir(worktreePath, { recursive: true });
        }
        return removeResult;
      },
      removePath: async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(created.worktreePath)) {
          const error = new Error(`EBUSY: resource busy or locked, rmdir '${targetPath}'`);
          error.code = 'EBUSY';
          throw error;
        }

        await removePath(targetPath);
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'pruneWorktrees should report incomplete cleanup');
  assert.equal(caught.id, 'prune_cleanup_incomplete');
  assert.equal(await pathExists(created.worktreePath), true);
  assert.equal(
    caught.details.failures.some(
      (failure) =>
        failure.worktreeId === created.worktreeId &&
        failure.stateRemoved === false &&
        failure.failures.some((detail) => detail.step === 'remove_path')
    ),
    true,
  );

  let state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].worktreeId, created.worktreeId);

  const retryResult = await runCli(fixture.repoDir, ['doctor', '--fix', '--json']);
  const retryJson = JSON.parse(retryResult.stdout);
  assert.equal(
    retryJson.result.actions.some(
      (action) =>
        action.id === 'remove_stale_registry_entry' &&
        action.worktreeId === created.worktreeId
    ),
    true,
  );
  assert.equal(await pathExists(created.worktreePath), false);

  state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 0);
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

test('mwt drop --dry-run plans removal without mutating the repository', async () => {
  const fixture = await createRepoWithRemote();
  await runCli(fixture.repoDir, ['init', '--base', 'main', '--json']);
  const createResult = await runCli(fixture.repoDir, ['create', 'preview-drop', '--json']);
  const createJson = JSON.parse(createResult.stdout);
  const taskPath = createJson.result.worktreePath;

  const dryRunResult = await runCli(
    fixture.repoDir,
    ['drop', 'preview-drop', '--delete-branch', '--dry-run', '--json'],
  );
  const dryRunJson = JSON.parse(dryRunResult.stdout);
  assert.equal(dryRunJson.result.dryRun, true);
  assert.equal(dryRunJson.result.actions.some((action) => action.id === 'drop_worktree'), true);
  assert.equal(dryRunJson.result.actions.some((action) => action.id === 'drop_branch'), true);
  assert.equal(await pathExists(taskPath), true);

  const state = await readJson(path.join(fixture.repoDir, '.mwt', 'state', 'worktrees.json'));
  assert.equal(state.items.length, 1);
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
