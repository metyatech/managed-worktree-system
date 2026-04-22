import { createHash, randomBytes } from 'node:crypto';
import { cp, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Minimatch } from 'minimatch';
import { parse, stringify } from 'smol-toml';

import {
  DEFAULT_BOOTSTRAP_PROFILE,
  DEFAULT_IGNORED_ENTRIES,
  EXIT_CODES,
  HOOK_APPROVALS_FILE,
  LAST_DELIVER_STATE_FILE,
  LAST_SYNC_STATE_FILE,
  MWT_CONFIG_FILE,
  MWT_DIR,
  MWT_HOOK_DIR,
  MWT_LOG_DIR,
  MWT_MARKER_FILE,
  MWT_STATE_DIR,
  MWT_TEMPLATE_DIR,
  SEED_STATE_FILE,
  LOCKS_DIR,
  TOOL_STATE_VERSION,
  WORKTREE_STATE_FILE,
} from './constants.mjs';
import { MwtError } from './errors.mjs';
import {
  ensureDir,
  pathExists,
  readJson,
  readText,
  removePath,
  toPortablePath,
  writeJson,
  writeText,
} from './fs.mjs';
import {
  addPaths,
  addWorktree,
  branchExists,
  commitStaged,
  deleteBranch,
  fastForwardBranch,
  fetchBranch,
  getCommitIdentity,
  getAheadBehind,
  getCurrentBranch,
  getGitDir,
  getMergeBase,
  getGitPath,
  getHeadCommit,
  getRepoRoot,
  getUpstreamBranch,
  hasMergeConflicts,
  hasTrackedChanges,
  isBareRepository,
  isBranchMerged,
  listChangedFiles,
  listTrackedChanges,
  listUntrackedChanges,
  pushHeadToBranch,
  rebaseOnto,
  removeWorktree,
  stashPop,
  stashPush,
  updateSubmodules,
  worktreeList,
} from './git.mjs';
import { clearExpiredLocks, listLocks, lockIssueFromRecord } from './locks.mjs';
import { runShell } from './process.mjs';
import { findProcessesHoldingCwd } from './process-cwd.mjs';

export function slugifyName(name) {
  const slug = name
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .replaceAll(/-+/gu, '-')
    .toLowerCase();

  if (!slug) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'invalid_worktree_name',
      message:
        'Worktree name must contain at least one alphanumeric character.',
      details: {
        name,
      },
    });
  }

  return slug;
}

export function createShortId() {
  return randomBytes(4).toString('hex');
}

export function getManagedPaths(seedRoot) {
  return {
    seedRoot,
    configPath: path.join(seedRoot, MWT_CONFIG_FILE),
    markerPath: path.join(seedRoot, MWT_MARKER_FILE),
    mwtDir: path.join(seedRoot, MWT_DIR),
    hooksDir: path.join(seedRoot, MWT_HOOK_DIR),
    templatesDir: path.join(seedRoot, MWT_TEMPLATE_DIR),
    stateDir: path.join(seedRoot, MWT_STATE_DIR),
    locksDir: path.join(seedRoot, LOCKS_DIR),
    logsDir: path.join(seedRoot, MWT_LOG_DIR),
    hookApprovalsPath: path.join(seedRoot, HOOK_APPROVALS_FILE),
    seedStatePath: path.join(seedRoot, SEED_STATE_FILE),
    worktreeStatePath: path.join(seedRoot, WORKTREE_STATE_FILE),
    lastDeliverPath: path.join(seedRoot, LAST_DELIVER_STATE_FILE),
    lastSyncPath: path.join(seedRoot, LAST_SYNC_STATE_FILE),
  };
}

export async function detectContext(cwd = process.cwd()) {
  const worktreeRoot = await getRepoRoot(cwd);
  const marker = await loadMarker(worktreeRoot);
  const seedRoot = marker?.kind === 'task' ? marker.repoRoot : worktreeRoot;

  return {
    cwd,
    worktreeRoot,
    marker,
    seedRoot,
  };
}

export async function loadMarker(worktreeRoot) {
  const markerPath = path.join(worktreeRoot, MWT_MARKER_FILE);
  if (!(await pathExists(markerPath))) {
    return null;
  }

  const marker = await readJson(markerPath);
  validateMarker(marker);
  return marker;
}

export function validateMarker(marker) {
  if (!marker || typeof marker !== 'object') {
    throw new MwtError({
      code: EXIT_CODES.NOT_INITIALIZED,
      id: 'invalid_marker',
      message: 'Managed worktree marker is invalid.',
    });
  }

  for (const key of ['version', 'kind', 'repoRoot']) {
    if (!(key in marker)) {
      throw new MwtError({
        code: EXIT_CODES.NOT_INITIALIZED,
        id: 'invalid_marker',
        message: `Managed worktree marker is missing required key: ${key}`,
      });
    }
  }
}

export async function loadConfig(seedRoot) {
  const { configPath } = getManagedPaths(seedRoot);
  if (!(await pathExists(configPath))) {
    throw new MwtError({
      code: EXIT_CODES.NOT_INITIALIZED,
      id: 'missing_config',
      message: 'Repository is not initialized for managed-worktree-system.',
    });
  }

  const content = await readText(configPath);
  const config = parse(content);
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  for (const key of [
    'version',
    'default_branch',
    'default_remote',
    'task_worktree_dir_template',
    'task_branch_template',
    'bootstrap',
    'policy',
  ]) {
    if (!(key in config)) {
      throw new MwtError({
        code: EXIT_CODES.NOT_INITIALIZED,
        id: 'invalid_config',
        message: `Managed worktree config is missing required key: ${key}`,
      });
    }
  }
}

export async function discoverVerifyCommand(seedRoot) {
  const packageJsonPath = path.join(seedRoot, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    const scriptEntryPoints = [
      ['scripts/verify.mjs', 'node scripts/verify.mjs'],
      ['scripts/verify.js', 'node scripts/verify.js'],
      ['scripts/verify.cjs', 'node scripts/verify.cjs'],
      ['scripts/verify.ps1', 'pwsh -File scripts/verify.ps1'],
      ['scripts/verify.cmd', '.\\scripts\\verify.cmd'],
      ['scripts/verify.sh', 'sh scripts/verify.sh'],
    ];

    for (const [relativePath, command] of scriptEntryPoints) {
      if (await pathExists(path.join(seedRoot, relativePath))) {
        return command;
      }
    }

    return '';
  }

  const packageJson = await readJson(packageJsonPath);
  return packageJson?.scripts?.verify ? 'npm run verify' : '';
}

function buildMissingVerifyCommandError(seedRoot) {
  return new MwtError({
    code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
    id: 'init_verify_command_required',
    message:
      'mwt init requires a discoverable verify command. Repositories with package.json must define scripts.verify; repositories without package.json must provide a supported scripts/verify.* wrapper.',
    details: {
      seedRoot: toPortablePath(seedRoot),
      supportedWrappers: [
        'scripts/verify.mjs',
        'scripts/verify.js',
        'scripts/verify.cjs',
        'scripts/verify.ps1',
        'scripts/verify.cmd',
        'scripts/verify.sh',
      ],
      recovery:
        'Add scripts.verify to package.json, or remove package.json and add one of the supported scripts/verify.* wrappers before rerunning mwt init.',
    },
  });
}

const INIT_CONFIG_COMMIT_MESSAGE =
  'Initialize managed-worktree-system configuration';

async function commitManagedConfig(seedRoot) {
  const identity = await getCommitIdentity(seedRoot);
  if (!identity) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_commit_identity_missing',
      message:
        'mwt init could not determine a Git commit identity for the initial .mwt/config.toml commit.',
      details: {
        recovery:
          'Configure user.name and user.email or create an initial commit, then rerun mwt init.',
      },
    });
  }

  await addPaths(seedRoot, [MWT_CONFIG_FILE]);
  const commitResult = await commitStaged(
    seedRoot,
    INIT_CONFIG_COMMIT_MESSAGE,
    identity,
  );
  if (commitResult.code !== 0) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_config_commit_failed',
      message:
        `mwt init could not commit .mwt/config.toml: ${commitResult.stderr || commitResult.stdout}`.trim(),
    });
  }
}

export function createDefaultConfig({
  defaultBranch,
  defaultRemote,
  verifyCommand,
}) {
  return {
    version: TOOL_STATE_VERSION,
    default_branch: defaultBranch,
    default_remote: defaultRemote,
    task_worktree_dir_template:
      '{{ seed_parent }}/{{ repo }}-wt-{{ slug }}-{{ shortid }}',
    task_branch_template: 'wt/{{ slug }}/{{ shortid }}',
    bootstrap: {
      enabled: true,
      default_profile: DEFAULT_BOOTSTRAP_PROFILE,
      profiles: {
        local: {
          include: ['.env', '.env.local', '.env.*.local'],
          exclude: ['node_modules/', '.venv/', '.next/', 'dist/'],
        },
      },
    },
    verify: {
      command: verifyCommand,
    },
    policy: {
      allow_ignored_seed_changes: true,
      allow_tracked_seed_changes: false,
    },
  };
}

export async function writeDefaultConfig(seedRoot, options) {
  const { configPath } = getManagedPaths(seedRoot);
  const config = createDefaultConfig(options);
  await writeText(configPath, `${stringify(config)}\n`);
  return config;
}

export function renderTemplate(template, values) {
  return template.replaceAll(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu,
    (_match, key) => {
      if (!(key in values)) {
        throw new MwtError({
          code: EXIT_CODES.INVALID_USAGE,
          id: 'unknown_template_key',
          message: `Unknown template key: ${key}`,
        });
      }

      return values[key];
    },
  );
}

export function renderTaskPath(seedRoot, config, slug, shortid) {
  return renderTaskPathFromTemplate(
    seedRoot,
    config.task_worktree_dir_template,
    slug,
    shortid,
  );
}

export function renderTaskPathFromTemplate(seedRoot, template, slug, shortid) {
  const repo = path.basename(seedRoot);
  const seedParent = path.resolve(path.dirname(seedRoot));
  const rendered = renderTemplate(template, {
    repo,
    seed_root: seedRoot,
    seed_parent: seedParent,
    slug,
    shortid,
  });

  const resolved = path.resolve(seedRoot, rendered);
  if (path.dirname(resolved) !== seedParent) {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'invalid_worktree_path',
      message:
        'Rendered worktree path must resolve to a sibling of the seed worktree.',
      details: {
        rendered: toPortablePath(resolved),
      },
    });
  }

  return resolved;
}

export function renderTaskBranch(config, slug, shortid) {
  return renderTaskBranchFromTemplate(
    config.task_branch_template,
    slug,
    shortid,
  );
}

export function renderTaskBranchFromTemplate(template, slug, shortid) {
  return renderTemplate(template, {
    slug,
    shortid,
  });
}

function resolveTaskTemplates(config, options = {}) {
  return {
    pathTemplate: options.pathTemplate ?? config.task_worktree_dir_template,
    branchTemplate: options.branchTemplate ?? config.task_branch_template,
  };
}

export async function ensureManagedDirs(seedRoot) {
  const managedPaths = getManagedPaths(seedRoot);
  await ensureDir(managedPaths.mwtDir);
  await ensureDir(managedPaths.hooksDir);
  await ensureDir(managedPaths.templatesDir);
  await ensureDir(managedPaths.stateDir);
  await ensureDir(managedPaths.locksDir);
  await ensureDir(managedPaths.logsDir);
}

export async function ensureLocalExcludeEntries(
  seedRoot,
  entries = DEFAULT_IGNORED_ENTRIES,
) {
  const localExcludePath = path.resolve(
    seedRoot,
    await getGitPath(seedRoot, 'info/exclude'),
  );
  const current = await readText(localExcludePath, '');
  const normalized = current.split(/\r?\n/u).filter(Boolean);
  let updated = current;

  for (const entry of entries) {
    if (!normalized.includes(entry)) {
      updated += updated.endsWith('\n') || updated.length === 0 ? '' : '\n';
      updated += `${entry}\n`;
    }
  }

  if (updated !== current) {
    await writeText(localExcludePath, updated);
  }
}

export async function writeSeedMarker(seedRoot, data) {
  const managedPaths = getManagedPaths(seedRoot);
  const marker = {
    version: TOOL_STATE_VERSION,
    kind: 'seed',
    repoId: data.repoId,
    repoRoot: toPortablePath(seedRoot),
    defaultBranch: data.defaultBranch,
    defaultRemote: data.defaultRemote,
  };

  await writeJson(managedPaths.markerPath, marker);
  return marker;
}

export async function writeTaskMarker(worktreeRoot, data) {
  const marker = {
    version: TOOL_STATE_VERSION,
    kind: 'task',
    repoId: data.repoId,
    repoRoot: toPortablePath(data.repoRoot),
    worktreeName: data.worktreeName,
    worktreeSlug: data.worktreeSlug,
    worktreeId: data.worktreeId,
    worktreePath: toPortablePath(worktreeRoot),
    branch: data.branch,
    baseBranch: data.baseBranch,
    targetBranch: data.targetBranch,
    createdAt: data.createdAt,
    createdBy: data.createdBy,
  };

  await writeJson(path.join(worktreeRoot, MWT_MARKER_FILE), marker);
  return marker;
}

export async function readWorktreeState(seedRoot) {
  const { worktreeStatePath } = getManagedPaths(seedRoot);
  return readJson(worktreeStatePath, {
    version: TOOL_STATE_VERSION,
    items: [],
  });
}

export async function writeWorktreeState(seedRoot, state) {
  const { worktreeStatePath } = getManagedPaths(seedRoot);
  await writeJson(worktreeStatePath, state);
}

export async function upsertWorktreeState(seedRoot, item) {
  const state = await readWorktreeState(seedRoot);
  const nextItems = state.items.filter(
    (entry) => entry.worktreeId !== item.worktreeId,
  );
  nextItems.push(item);
  nextItems.sort((left, right) => left.name.localeCompare(right.name));
  await writeWorktreeState(seedRoot, {
    version: TOOL_STATE_VERSION,
    items: nextItems,
  });
}

export async function removeWorktreeStateEntry(seedRoot, worktreeId) {
  const state = await readWorktreeState(seedRoot);
  await writeWorktreeState(seedRoot, {
    version: TOOL_STATE_VERSION,
    items: state.items.filter((item) => item.worktreeId !== worktreeId),
  });
}

export async function updateWorktreeStatus(seedRoot, worktreeId, status) {
  const state = await readWorktreeState(seedRoot);
  await writeWorktreeState(seedRoot, {
    version: TOOL_STATE_VERSION,
    items: state.items.map((item) =>
      item.worktreeId === worktreeId ? { ...item, status } : item,
    ),
  });
}

export async function writeSeedState(seedRoot, state) {
  const { seedStatePath } = getManagedPaths(seedRoot);
  await writeJson(seedStatePath, {
    version: TOOL_STATE_VERSION,
    ...state,
  });
}

export async function writeLastSyncState(seedRoot, state) {
  const { lastSyncPath } = getManagedPaths(seedRoot);
  await writeJson(lastSyncPath, {
    version: TOOL_STATE_VERSION,
    ...state,
  });
}

export async function writeLastDeliverState(seedRoot, state) {
  const { lastDeliverPath } = getManagedPaths(seedRoot);
  await writeJson(lastDeliverPath, {
    version: TOOL_STATE_VERSION,
    ...state,
  });
}

export async function assertSeedClean(seedRoot, options = {}) {
  if (options.allowDirtySeed) {
    return;
  }

  if (!(await hasTrackedChanges(seedRoot))) {
    return;
  }

  throw new MwtError({
    code: EXIT_CODES.SEED_POLICY_VIOLATION,
    id: 'seed_tracked_dirty',
    message: 'Seed worktree has tracked changes and cannot proceed.',
    details: {
      changedFiles: await listTrackedChanges(seedRoot),
      recovery:
        'Move tracked edits into a task worktree or discard them, rerun the command, or use --allow-dirty-seed when you intentionally want to bypass the clean-seed policy guard.',
    },
  });
}

export async function assertTaskClean(taskRoot) {
  if (!(await hasTrackedChanges(taskRoot))) {
    return;
  }

  throw new MwtError({
    code: EXIT_CODES.TASK_POLICY_VIOLATION,
    id: 'task_tracked_dirty',
    message: 'Task worktree has tracked changes that are not committed.',
    details: {
      changedFiles: await listTrackedChanges(taskRoot),
      recovery:
        'Commit task changes in the task worktree before delivering or pruning it.',
    },
  });
}

export async function initializeRepository(seedRoot, options = {}) {
  const managedPaths = getManagedPaths(seedRoot);

  if (await pathExists(managedPaths.configPath)) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'already_initialized',
      message: 'Repository is already initialized for managed-worktree-system.',
    });
  }

  if (await isBareRepository(seedRoot)) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_non_bare_repo',
      message:
        'mwt init requires a normal non-bare repository as the seed worktree.',
    });
  }

  const gitDir = await getGitDir(seedRoot);
  if (gitDir !== '.git') {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_primary_repo',
      message:
        'mwt init requires the primary non-bare repository checkout, not a linked worktree or redirected Git dir.',
      details: {
        gitDir,
      },
    });
  }

  if (!options.force && (await hasTrackedChanges(seedRoot))) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_clean_repo',
      message:
        'Repository must be clean before init unless --force is supplied.',
      details: {
        changedFiles: await listTrackedChanges(seedRoot),
      },
    });
  }

  const defaultBranch = options.base ?? (await getCurrentBranch(seedRoot));
  const defaultRemote = options.remote ?? 'origin';
  const verifyCommand = await discoverVerifyCommand(seedRoot);
  if (!verifyCommand) {
    throw buildMissingVerifyCommandError(seedRoot);
  }

  await ensureManagedDirs(seedRoot);
  const config = await writeDefaultConfig(seedRoot, {
    defaultBranch,
    defaultRemote,
    verifyCommand,
  });
  await ensureLocalExcludeEntries(seedRoot);
  await commitManagedConfig(seedRoot);
  const seedMarker = await writeSeedMarker(seedRoot, {
    repoId: options.repoId ?? path.basename(seedRoot),
    defaultBranch,
    defaultRemote,
  });
  const headCommit = await getHeadCommit(seedRoot);
  await writeSeedState(seedRoot, {
    branch: defaultBranch,
    remote: defaultRemote,
    lastSyncAt: null,
    lastSyncCommit: headCommit,
    status: 'healthy',
  });
  await writeWorktreeState(seedRoot, {
    version: TOOL_STATE_VERSION,
    items: [],
  });

  return {
    initialized: true,
    config,
    seedMarker,
    seedRoot: toPortablePath(seedRoot),
  };
}

export async function runHooks(seedRoot, hookType, context, options = {}) {
  const config = await loadConfig(seedRoot);
  const hooks = config.hooks?.[hookType];
  if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) {
    return [];
  }

  const managedPaths = getManagedPaths(seedRoot);
  const approvals = await readJson(managedPaths.hookApprovalsPath, {});
  const executed = [];

  for (const [name, command] of Object.entries(hooks)) {
    const digest = createHash('sha256').update(command).digest('hex');
    const approvalKey = `${hookType}:${name}`;
    const approved = approvals[approvalKey] === digest;

    if (!approved && !options.yes) {
      throw new MwtError({
        code: EXIT_CODES.HOOK_FAILURE,
        id: 'hook_requires_approval',
        message: `Hook ${approvalKey} requires approval. Re-run with --yes to approve and execute it.`,
      });
    }

    if (!approved && options.yes) {
      approvals[approvalKey] = digest;
      await writeJson(managedPaths.hookApprovalsPath, approvals);
    }

    const result = await runShell(command, {
      cwd: seedRoot,
      env: {
        MWT_SEED_PATH: seedRoot,
        ...(options.worktreePath
          ? { MWT_WORKTREE_PATH: options.worktreePath }
          : {}),
      },
      input: `${JSON.stringify(context)}\n`,
    });

    if (result.code !== 0) {
      throw new MwtError({
        code: EXIT_CODES.HOOK_FAILURE,
        id: 'hook_failed',
        message: `Hook ${approvalKey} failed.`,
        details: {
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        },
      });
    }

    executed.push({
      name,
      command,
    });
  }

  return executed;
}

export async function listIgnoredFiles(seedRoot) {
  const result = await runShell(
    'git ls-files --others -i --exclude-standard -z',
    {
      cwd: seedRoot,
    },
  );
  if (result.code !== 0) {
    throw new MwtError({
      message:
        `Failed to enumerate ignored files: ${result.stderr || result.stdout}`.trim(),
    });
  }

  return result.stdout.split('\u0000').filter(Boolean);
}

function compilePatterns(patterns) {
  return patterns.map(
    (pattern) =>
      new Minimatch(pattern, {
        dot: true,
        nocase: process.platform === 'win32',
      }),
  );
}

function matchesAny(matchers, value) {
  return matchers.some((matcher) => matcher.match(value));
}

function resolveBootstrapProfile(config, profileName = undefined) {
  const profileKey =
    profileName ??
    config.bootstrap?.default_profile ??
    DEFAULT_BOOTSTRAP_PROFILE;
  const profile = config.bootstrap?.profiles?.[profileKey];
  if (!profile) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'unknown_bootstrap_profile',
      message: `Bootstrap profile does not exist: ${profileKey}`,
    });
  }

  return {
    profileKey,
    profile,
  };
}

export function bootstrapEnabled(config, options = {}) {
  if (options.bootstrap === true) {
    return true;
  }

  if (options.bootstrap === false) {
    return false;
  }

  return config.bootstrap?.enabled !== false;
}

export async function getBootstrapCandidates(
  seedRoot,
  config,
  profileName = undefined,
) {
  const { profileKey, profile } = resolveBootstrapProfile(config, profileName);
  const includeMatchers = compilePatterns(profile.include ?? []);
  const excludeMatchers = compilePatterns(profile.exclude ?? []);
  const ignoredFiles = await listIgnoredFiles(seedRoot);
  const candidates = [];

  for (const relativePath of ignoredFiles) {
    if (
      !matchesAny(includeMatchers, relativePath) ||
      matchesAny(excludeMatchers, relativePath)
    ) {
      continue;
    }

    candidates.push(relativePath);
  }

  return {
    profileKey,
    candidates,
  };
}

export async function copyBootstrapFiles(
  seedRoot,
  taskRoot,
  config,
  profileName = undefined,
) {
  const { profileKey, candidates } = await getBootstrapCandidates(
    seedRoot,
    config,
    profileName,
  );
  const copied = [];

  for (const relativePath of candidates) {
    const sourcePath = path.join(seedRoot, relativePath);
    const destinationPath = path.join(taskRoot, relativePath);
    if (await pathExists(destinationPath)) {
      continue;
    }

    await ensureDir(path.dirname(destinationPath));
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: false,
    });
    copied.push(relativePath);
  }

  return {
    profileKey,
    copied,
  };
}

async function resolveCreateStartPoint(seedRoot, config, baseBranch) {
  const remoteStartPoint = `${config.default_remote}/${baseBranch}`;
  const divergence = await getAheadBehind(seedRoot, baseBranch, remoteStartPoint);
  if (divergence && divergence.behind === 0) {
    return {
      startPoint: baseBranch,
      startPointSource: 'local',
    };
  }

  return {
    startPoint: remoteStartPoint,
    startPointSource: 'remote',
  };
}

async function canReplayManagedConfigCommit(seedRoot, branch, remote, mergeResult) {
  if (mergeResult.code === 0) {
    return false;
  }

  const divergence = await getAheadBehind(seedRoot, branch, `${remote}/${branch}`);
  if (!divergence || divergence.ahead === 0 || divergence.behind === 0) {
    return false;
  }

  const mergeBase = await getMergeBase(seedRoot, branch, `${remote}/${branch}`);
  if (!mergeBase) {
    return false;
  }

  const localOnlyFiles = await listChangedFiles(seedRoot, mergeBase, branch);
  return (
    localOnlyFiles.length > 0 &&
    localOnlyFiles.every((relativePath) => relativePath === MWT_CONFIG_FILE)
  );
}

export async function planInitializeRepository(seedRoot, options = {}) {
  const managedPaths = getManagedPaths(seedRoot);
  if (await pathExists(managedPaths.configPath)) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'already_initialized',
      message: 'Repository is already initialized for managed-worktree-system.',
    });
  }

  if (await isBareRepository(seedRoot)) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_non_bare_repo',
      message:
        'mwt init requires a normal non-bare repository as the seed worktree.',
    });
  }

  const gitDir = await getGitDir(seedRoot);
  if (gitDir !== '.git') {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_primary_repo',
      message:
        'mwt init requires the primary non-bare repository checkout, not a linked worktree or redirected Git dir.',
      details: {
        gitDir,
      },
    });
  }

  if (!options.force && (await hasTrackedChanges(seedRoot))) {
    throw new MwtError({
      code: EXIT_CODES.UNSUPPORTED_INIT_STATE,
      id: 'init_requires_clean_repo',
      message:
        'Repository must be clean before init unless --force is supplied.',
      details: {
        changedFiles: await listTrackedChanges(seedRoot),
      },
    });
  }

  const defaultBranch = options.base ?? (await getCurrentBranch(seedRoot));
  const defaultRemote = options.remote ?? 'origin';
  const verifyCommand = await discoverVerifyCommand(seedRoot);
  if (!verifyCommand) {
    throw buildMissingVerifyCommandError(seedRoot);
  }

  return {
    dryRun: true,
    seedRoot: toPortablePath(seedRoot),
    defaultBranch,
    defaultRemote,
    verifyCommand,
    actions: [
      {
        id: 'validate_seed_repo',
        description:
          'Verify the seed repository is a clean primary non-bare checkout.',
      },
      {
        id: 'create_managed_dirs',
        description:
          'Create .mwt directories for config, state, locks, logs, hooks, and templates.',
      },
      {
        id: 'write_config',
        description:
          'Write .mwt/config.toml with default branch, remote, and verify command.',
      },
      {
        id: 'update_local_exclude',
        description: 'Add managed runtime paths to .git/info/exclude.',
      },
      {
        id: 'commit_config',
        description:
          'Create the initial tracked commit for .mwt/config.toml so later create/deliver/sync operations do not depend on an untracked config file.',
      },
      {
        id: 'write_seed_marker',
        description: 'Write the seed .mwt-worktree.json marker.',
      },
      {
        id: 'write_seed_state',
        description: 'Write seed.json and initialize worktrees.json.',
      },
    ],
  };
}

export async function planCreateTaskWorktree(seedRoot, taskName, options = {}) {
  const config = await loadConfig(seedRoot);
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });

  const baseBranch = options.base ?? config.default_branch;
  const targetBranch = options.target ?? config.default_branch;
  const slug = slugifyName(taskName);
  const previewId = 'preview000';
  const templates = resolveTaskTemplates(config, options);
  const worktreePath = renderTaskPathFromTemplate(
    seedRoot,
    templates.pathTemplate,
    slug,
    previewId,
  );
  const branch = renderTaskBranchFromTemplate(
    templates.branchTemplate,
    slug,
    previewId,
  );

  if (await pathExists(worktreePath)) {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'worktree_path_occupied',
      message: 'Target worktree path is already occupied.',
      details: {
        worktreePath: toPortablePath(worktreePath),
      },
    });
  }

  const bootstrapPlan = bootstrapEnabled(config, options)
    ? await getBootstrapCandidates(seedRoot, config, options.copyProfile)
    : {
        profileKey:
          options.copyProfile ??
          config.bootstrap?.default_profile ??
          DEFAULT_BOOTSTRAP_PROFILE,
        candidates: [],
      };

  return {
    dryRun: true,
    worktreeName: taskName,
    worktreeSlug: slug,
    previewId,
    worktreePath: toPortablePath(worktreePath),
    branch,
    baseBranch,
    targetBranch,
    bootstrapProfile: bootstrapPlan.profileKey,
    bootstrapCandidates: bootstrapPlan.candidates,
    actions: [
      {
        id: 'fetch_base',
        description: `Fetch ${config.default_remote}/${baseBranch}.`,
      },
      {
        id: 'add_worktree',
        description: `Create branch ${branch} and sibling worktree ${toPortablePath(worktreePath)} from the latest safe base (local ${baseBranch} when it already contains seed-only commits, otherwise ${config.default_remote}/${baseBranch}).`,
      },
      {
        id: 'update_submodules',
        description:
          'Initialize Git submodules in the new task worktree when .gitmodules is present.',
      },
      {
        id: 'write_task_marker',
        description: 'Write .mwt-worktree.json in the task worktree.',
      },
      {
        id: 'run_pre_create_hooks',
        description: 'Run blocking pre_create hooks.',
      },
      {
        id: 'copy_bootstrap',
        description: `Copy ${bootstrapPlan.candidates.length} allowlisted ignored file(s) using profile ${bootstrapPlan.profileKey}.`,
      },
      { id: 'run_post_create_hooks', description: 'Run post_create hooks.' },
      {
        id: 'register_worktree',
        description: 'Append the task worktree to worktrees.json.',
      },
    ],
  };
}

export async function planSyncSeed(seedRoot, options = {}) {
  const config = await loadConfig(seedRoot);
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });

  const branch = options.base ?? config.default_branch;
  return {
    dryRun: true,
    branch,
    remote: config.default_remote,
    before: await getHeadCommit(seedRoot),
    actions: [
      {
        id: 'fetch_target',
        description: `Fetch ${config.default_remote}/${branch}.`,
      },
      {
        id: 'fast_forward_seed',
        description: `Fast-forward the seed worktree to ${config.default_remote}/${branch}.`,
      },
      {
        id: 'write_sync_state',
        description: 'Update seed.json and last-sync.json.',
      },
    ],
  };
}

export async function planDeliverTaskWorktree(taskRoot, options = {}) {
  const marker = await loadMarker(taskRoot);
  if (!marker || marker.kind !== 'task') {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'not_a_task_worktree',
      message: 'Deliver must run against a managed task worktree.',
    });
  }

  const seedRoot = marker.repoRoot;
  const config = await loadConfig(seedRoot);
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });
  if (!options.allowDirtyTask) {
    await assertTaskClean(taskRoot);
  }

  const state = await readWorktreeState(seedRoot);
  const item =
    state.items.find((entry) => entry.worktreeId === marker.worktreeId) ?? null;
  if (
    options.resume &&
    item &&
    !['conflict', 'delivering'].includes(item.status)
  ) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'deliver_resume_not_needed',
      message:
        'deliver --resume is only valid for a conflicted or interrupted task worktree.',
      details: {
        currentStatus: item.status,
      },
    });
  }

  const targetBranch =
    options.target ?? marker.targetBranch ?? config.default_branch;
  const verifySkipped = Boolean(options.skipVerify);
  const actions = [
    {
      id: 'mark_delivering',
      description: 'Set runtime state to delivering.',
    },
    {
      id: 'fetch_target',
      description: `Fetch ${config.default_remote}/${targetBranch}.`,
    },
    {
      id: 'rebase_task',
      description: `Rebase the task branch onto ${config.default_remote}/${targetBranch}.`,
    },
    {
      id: 'run_pre_deliver_hooks',
      description: 'Run blocking pre_deliver hooks.',
    },
    ...(verifySkipped
      ? []
      : [
          {
            id: 'run_verify',
            description: `Run ${config.verify?.command ?? 'the configured verify command'}.`,
          },
        ]),
    {
      id: 'push_target',
      description: `Push HEAD to ${config.default_remote}:${targetBranch}.`,
    },
    {
      id: 'sync_seed',
      description: `Fast-forward the seed worktree to ${config.default_remote}/${targetBranch}.`,
    },
    { id: 'run_post_deliver_hooks', description: 'Run post_deliver hooks.' },
    {
      id: 'mark_delivered',
      description: 'Persist last-deliver.json and mark the task as delivered.',
    },
  ];

  return {
    dryRun: true,
    worktreeId: marker.worktreeId,
    worktreeName: marker.worktreeName,
    taskPath: marker.worktreePath,
    targetBranch,
    verifyCommand: verifySkipped ? null : (config.verify?.command ?? null),
    verifySkipped,
    currentStatus: item?.status ?? 'active',
    actions,
  };
}

/**
 * Best-effort rollback for `createTaskWorktree` when it crashes AFTER
 * the underlying `git worktree add` succeeded. Leaving the worktree
 * link, its filesystem directory (potentially bootstrapped with
 * node_modules etc.), or the detached branch behind causes two nasty
 * failure modes: subsequent `createTaskWorktree` calls hit
 * `worktree_path_occupied`, and callers see ghost directories that
 * look like zombie worktrees in `git worktree list`.
 *
 * Every step is wrapped so a single failure does not short-circuit
 * the others: we always attempt worktree unlink, directory removal,
 * and branch deletion in order.
 */
async function rollbackPartialTaskWorktree(
  seedRoot,
  worktreePath,
  branch,
  shortid,
) {
  const errors = [];
  if (await pathExists(worktreePath).catch(() => false)) {
    try {
      await removeWorktree(seedRoot, worktreePath, true);
    } catch (error) {
      errors.push(error);
    }
    try {
      if (await pathExists(worktreePath).catch(() => false)) {
        await removePath(worktreePath);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (branch) {
    try {
      await deleteBranch(seedRoot, branch, true);
    } catch (error) {
      errors.push(error);
    }
  }
  if (shortid) {
    try {
      await removeWorktreeStateEntry(seedRoot, shortid);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    console.warn(
      `[mwt] rollback after failed createTaskWorktree encountered ${errors.length} issue(s); the seed may still have partial state for ${toPortablePath(worktreePath)}: ${errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ')}`,
    );
  }
}

function formatCleanupFailureMessage(value, fallback) {
  if (value instanceof Error) {
    return value.message;
  }

  if (
    value &&
    typeof value === 'object' &&
    'stderr' in value &&
    'stdout' in value
  ) {
    const stderr = typeof value.stderr === 'string' ? value.stderr.trim() : '';
    const stdout = typeof value.stdout === 'string' ? value.stdout.trim() : '';
    const code = typeof value.code === 'number' ? value.code : null;
    return (
      stderr || stdout || `${fallback}${code === null ? '' : ` (code ${code})`}`
    );
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return fallback;
}

function pushCleanupFailure(failures, step, error, extra = {}) {
  failures.push({
    step,
    message: formatCleanupFailureMessage(error, `Cleanup step failed: ${step}`),
    ...extra,
  });
}

function recordCleanupAction(actions, completedSteps, action, summary) {
  actions.push(action);
  completedSteps.push(summary);
}

async function isLiveGitWorktree(seedRoot, worktreePath) {
  const listed = await worktreeList(seedRoot);
  return listed
    .filter((entry) => !entry.bare)
    .some((entry) => path.resolve(entry.path) === path.resolve(worktreePath));
}

async function finalizeTaskCleanup(seedRoot, input) {
  const failures = [];
  const completedSteps = [];
  const worktreePath = input.taskRoot;
  const removeTaskPath = input.removePath ?? removePath;
  const removeTaskWorktree = input.removeWorktree ?? removeWorktree;
  const liveBefore = await isLiveGitWorktree(seedRoot, worktreePath);
  const pathBefore = await pathExists(worktreePath);

  if (liveBefore || pathBefore) {
    const removeResult = await removeTaskWorktree(seedRoot, worktreePath, true);
    if (removeResult.code !== 0) {
      pushCleanupFailure(failures, 'remove_worktree', removeResult, {
        path: toPortablePath(worktreePath),
      });
    }
  }

  const liveAfter = await isLiveGitWorktree(seedRoot, worktreePath);
  const worktreeRemoved = !liveAfter;

  if (worktreeRemoved && (liveBefore || pathBefore)) {
    completedSteps.push('remove_worktree');
  }

  let taskPathRemoved = false;
  const pathStillExists = await pathExists(worktreePath);
  if (worktreeRemoved && pathStillExists) {
    try {
      await removeTaskPath(worktreePath);
    } catch (error) {
      pushCleanupFailure(failures, 'remove_path', error, {
        path: toPortablePath(worktreePath),
      });
    }
  }

  taskPathRemoved = !(await pathExists(worktreePath));
  if (taskPathRemoved && pathBefore) {
    completedSteps.push('remove_path');
  }

  let branchDeleted = false;
  if (input.deleteBranch && input.branch && worktreeRemoved) {
    const deleteResult = await deleteBranch(
      seedRoot,
      input.branch,
      input.forceBranchDelete !== false,
    );
    branchDeleted =
      deleteResult.code === 0 || !(await branchExists(seedRoot, input.branch));
    if (branchDeleted) {
      completedSteps.push('delete_branch');
    } else {
      pushCleanupFailure(failures, 'delete_branch', deleteResult, {
        branch: input.branch,
      });
    }
  }

  let stateRemoved = false;
  if (worktreeRemoved && taskPathRemoved) {
    try {
      await removeWorktreeStateEntry(seedRoot, input.worktreeId);
      stateRemoved = true;
      completedSteps.push('remove_state_entry');
    } catch (error) {
      pushCleanupFailure(failures, 'remove_state_entry', error, {
        worktreeId: input.worktreeId,
      });
    }
  }

  return {
    worktreeRemoved,
    taskPathRemoved,
    branchDeleted,
    stateRemoved,
    completedSteps,
    failures,
  };
}

function throwCleanupIncomplete({
  id,
  message,
  worktreeId,
  taskName,
  taskPath,
  branch,
  worktreeRemoved,
  taskPathRemoved,
  branchDeleted,
  stateRemoved,
  completedSteps,
  failures,
}) {
  throw new MwtError({
    code: EXIT_CODES.UNSAFE_PRUNE_TARGET,
    id,
    message,
    details: {
      worktreeId,
      taskName,
      taskPath: toPortablePath(taskPath),
      branch,
      worktreeRemoved,
      taskPathRemoved,
      branchDeleted,
      stateRemoved,
      completedSteps,
      failures,
      recovery:
        'Resolve the blocking cleanup failure, then rerun the command or mwt doctor --deep --fix.',
    },
  });
}

async function ensureTaskWorktreeSubmodules(worktreePath) {
  if (!(await pathExists(path.join(worktreePath, '.gitmodules')))) {
    return;
  }

  const updateResult = await updateSubmodules(worktreePath);
  if (updateResult.code !== 0) {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'submodule_update_failed',
      message:
        `Failed to initialize submodules in the new task worktree: ${updateResult.stderr || updateResult.stdout}`.trim(),
      details: {
        worktreePath: toPortablePath(worktreePath),
      },
    });
  }
}

export async function createTaskWorktree(seedRoot, taskName, options = {}) {
  const config = await loadConfig(seedRoot);
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });

  const baseBranch = options.base ?? config.default_branch;
  const targetBranch = options.target ?? config.default_branch;
  const slug = slugifyName(taskName);
  const shortid = createShortId();
  const templates = resolveTaskTemplates(config, options);
  const worktreePath = renderTaskPathFromTemplate(
    seedRoot,
    templates.pathTemplate,
    slug,
    shortid,
  );
  const branch = renderTaskBranchFromTemplate(
    templates.branchTemplate,
    slug,
    shortid,
  );

  if (await pathExists(worktreePath)) {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'worktree_path_occupied',
      message: 'Target worktree path is already occupied.',
      details: {
        worktreePath: toPortablePath(worktreePath),
      },
    });
  }

  await fetchBranch(seedRoot, config.default_remote, baseBranch);
  const startPoint = await resolveCreateStartPoint(seedRoot, config, baseBranch);
  const addResult = await addWorktree(
    seedRoot,
    worktreePath,
    branch,
    startPoint.startPoint,
  );
  if (addResult.code !== 0) {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'worktree_add_failed',
      message:
        `Failed to create task worktree: ${addResult.stderr || addResult.stdout}`.trim(),
    });
  }

  // `git worktree add` has succeeded: from here on any failure must
  // roll the worktree back so we don't leave a half-created, half-
  // bootstrapped directory that future calls can't overwrite.
  try {
    await ensureTaskWorktreeSubmodules(worktreePath);
    await ensureLocalExcludeEntries(worktreePath);
    const marker = await writeTaskMarker(worktreePath, {
      repoId: path.basename(seedRoot),
      repoRoot: seedRoot,
      worktreeName: taskName,
      worktreeSlug: slug,
      worktreeId: shortid,
      branch,
      baseBranch,
      targetBranch,
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy ?? 'human',
    });

    const hookContext = {
      version: TOOL_STATE_VERSION,
      repoRoot: toPortablePath(seedRoot),
      seedPath: toPortablePath(seedRoot),
      defaultBranch: config.default_branch,
      defaultRemote: config.default_remote,
      worktree: {
        kind: 'task',
        name: taskName,
        slug,
        id: shortid,
        path: toPortablePath(worktreePath),
        branch,
        baseBranch,
        targetBranch,
      },
    };

    await runHooks(
      seedRoot,
      'pre_create',
      {
        ...hookContext,
        hookType: 'pre_create',
      },
      {
        yes: options.yes,
        worktreePath,
      },
    );

    const bootstrapResult = bootstrapEnabled(config, options)
      ? await copyBootstrapFiles(
          seedRoot,
          worktreePath,
          config,
          options.copyProfile,
        )
      : {
          profileKey:
            options.copyProfile ??
            config.bootstrap?.default_profile ??
            DEFAULT_BOOTSTRAP_PROFILE,
          copied: [],
        };

    await runHooks(
      seedRoot,
      'post_create',
      {
        ...hookContext,
        hookType: 'post_create',
      },
      {
        yes: options.yes,
        worktreePath,
      },
    );

    await upsertWorktreeState(seedRoot, {
      worktreeId: shortid,
      name: taskName,
      branch,
      path: toPortablePath(worktreePath),
      status: 'active',
      bootstrapFiles: bootstrapResult.copied,
    });

    return {
      worktreeName: taskName,
      worktreeSlug: slug,
      worktreeId: shortid,
      worktreePath: toPortablePath(worktreePath),
      branch,
      baseBranch,
      targetBranch,
      bootstrapProfile: bootstrapResult.profileKey,
      copiedFiles: bootstrapResult.copied,
      marker,
    };
  } catch (error) {
    await rollbackPartialTaskWorktree(seedRoot, worktreePath, branch, shortid);
    throw error;
  }
}

export async function listWorktrees(seedRoot, options = {}) {
  const entries = await worktreeList(seedRoot);
  const state = await readWorktreeState(seedRoot);
  const seedMarker = await loadMarker(seedRoot);
  const seedUpstream = await getUpstreamBranch(seedRoot);
  const seedDivergence = seedUpstream
    ? await getAheadBehind(seedRoot, 'HEAD', seedUpstream)
    : null;

  const items = [
    {
      path: toPortablePath(seedRoot),
      branch: await getCurrentBranch(seedRoot),
      head: await getHeadCommit(seedRoot),
      kind: seedMarker?.kind ?? 'seed',
      managedStatus: 'healthy',
      dirtyTracked: await hasTrackedChanges(seedRoot),
      upstream: seedUpstream,
      divergence: seedDivergence,
    },
  ];

  const seenPaths = new Set([path.resolve(seedRoot)]);
  for (const entry of entries) {
    if (entry.bare || seenPaths.has(path.resolve(entry.path))) {
      continue;
    }

    seenPaths.add(path.resolve(entry.path));
    const marker = await loadMarker(entry.path);
    const upstream = entry.branch ? await getUpstreamBranch(entry.path) : null;
    const divergence =
      entry.branch && upstream
        ? await getAheadBehind(entry.path, 'HEAD', upstream)
        : null;
    items.push({
      path: toPortablePath(entry.path),
      branch: entry.branch,
      head: entry.head,
      kind: marker?.kind ?? 'external',
      managedStatus:
        marker?.kind === 'task'
          ? (state.items.find((item) => item.worktreeId === marker.worktreeId)
              ?.status ?? 'active')
          : marker?.kind === 'seed'
            ? 'healthy'
            : 'unmanaged',
      dirtyTracked: await hasTrackedChanges(entry.path),
      upstream,
      divergence,
    });
  }

  return items.filter((item) => {
    if (!options.all && item.kind === 'external') {
      return false;
    }

    if (options.kind && item.kind !== options.kind) {
      return false;
    }

    if (options.status && item.managedStatus !== options.status) {
      return false;
    }

    return true;
  });
}

export async function syncSeed(seedRoot, options = {}) {
  const config = await loadConfig(seedRoot);
  const seedHadDirtyTracked = options.allowDirtySeed
    ? await hasTrackedChanges(seedRoot)
    : false;
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });

  const branch = options.base ?? config.default_branch;
  const remote = config.default_remote;
  const before = await getHeadCommit(seedRoot);
  const startedAt = new Date().toISOString();

  await fetchBranch(seedRoot, remote, branch);
  const mergeResult = await fastForwardBranch(seedRoot, remote, branch);
  if (mergeResult.code !== 0) {
    const canReplayManagedConfig = await canReplayManagedConfigCommit(
      seedRoot,
      branch,
      remote,
      mergeResult,
    );
    if (!canReplayManagedConfig) {
      throw new MwtError({
        code: EXIT_CODES.REMOTE_SYNC_FAILURE,
        id: 'seed_fast_forward_failed',
        message:
          `Seed worktree could not be fast-forwarded: ${mergeResult.stderr || mergeResult.stdout}`.trim(),
      });
    }

    let stashedDirtySeed = false;
    if (seedHadDirtyTracked) {
      const stashResult = await stashPush(
        seedRoot,
        'mwt-sync-managed-config-replay',
      );
      if (stashResult.code !== 0) {
        throw new MwtError({
          code: EXIT_CODES.REMOTE_SYNC_FAILURE,
          id: 'seed_fast_forward_failed',
          message:
            `Seed worktree could not prepare for replaying its managed config commit: ${stashResult.stderr || stashResult.stdout}`.trim(),
        });
      }
      stashedDirtySeed = true;
    }

    const rebaseResult = await rebaseOnto(seedRoot, remote, branch);
    if (rebaseResult.code !== 0 || (await hasMergeConflicts(seedRoot))) {
      if (stashedDirtySeed) {
        await stashPop(seedRoot);
      }
      throw new MwtError({
        code: EXIT_CODES.REMOTE_SYNC_FAILURE,
        id: 'seed_fast_forward_failed',
        message:
          `Seed worktree could not replay its local managed config commit onto ${remote}/${branch}: ${rebaseResult.stderr || rebaseResult.stdout}`.trim(),
      });
    }

    if (stashedDirtySeed) {
      const restoreResult = await stashPop(seedRoot);
      if (restoreResult.code !== 0) {
        throw new MwtError({
          code: EXIT_CODES.REMOTE_SYNC_FAILURE,
          id: 'seed_fast_forward_failed',
          message:
            `Seed worktree replayed its managed config commit but could not restore the caller's dirty seed changes: ${restoreResult.stderr || restoreResult.stdout}`.trim(),
        });
      }
    }
  }

  const after = await getHeadCommit(seedRoot);
  const finishedAt = new Date().toISOString();
  await writeSeedState(seedRoot, {
    branch,
    remote,
    lastSyncAt: finishedAt,
    lastSyncCommit: after,
    status: 'healthy',
  });
  await writeLastSyncState(seedRoot, {
    status: 'succeeded',
    startedAt,
    finishedAt,
    branch,
    before,
    after,
  });

  return {
    branch,
    remote,
    before,
    after,
  };
}

export async function findTaskByName(seedRoot, name) {
  const state = await readWorktreeState(seedRoot);
  const match = state.items.find(
    (item) => item.name === name || item.worktreeId === name,
  );
  if (match) {
    return match;
  }

  const listed = (await worktreeList(seedRoot)).filter((entry) => !entry.bare);
  for (const entry of listed) {
    if (path.resolve(entry.path) === path.resolve(seedRoot)) {
      continue;
    }

    const marker = await loadMarker(entry.path);
    if (
      marker?.kind === 'task' &&
      (marker.worktreeName === name || marker.worktreeId === name)
    ) {
      return {
        worktreeId: marker.worktreeId,
        name: marker.worktreeName,
        branch: marker.branch,
        path: marker.worktreePath,
        status: 'active',
      };
    }
  }

  throw new MwtError({
    code: EXIT_CODES.WORKTREE_NOT_FOUND,
    id: 'task_not_found',
    message: `Managed task worktree not found: ${name}`,
  });
}

export async function deliverTaskWorktree(taskRoot, options = {}) {
  const marker = await loadMarker(taskRoot);
  if (!marker || marker.kind !== 'task') {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'not_a_task_worktree',
      message: 'Deliver must run against a managed task worktree.',
    });
  }

  const seedRoot = marker.repoRoot;
  const config = await loadConfig(seedRoot);
  await assertSeedClean(seedRoot, {
    allowDirtySeed: options.allowDirtySeed,
  });
  if (!options.allowDirtyTask) {
    await assertTaskClean(taskRoot);
  }

  const state = await readWorktreeState(seedRoot);
  const item =
    state.items.find((entry) => entry.worktreeId === marker.worktreeId) ?? null;
  if (
    options.resume &&
    item &&
    !['conflict', 'delivering'].includes(item.status)
  ) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'deliver_resume_not_needed',
      message:
        'deliver --resume is only valid for a conflicted or interrupted task worktree.',
      details: {
        currentStatus: item.status,
      },
    });
  }

  const targetBranch =
    options.target ?? marker.targetBranch ?? config.default_branch;
  const remote = config.default_remote;
  const startedAt = new Date().toISOString();
  await updateWorktreeStatus(seedRoot, marker.worktreeId, 'delivering');

  await fetchBranch(taskRoot, remote, targetBranch);
  const rebaseResult = await rebaseOnto(taskRoot, remote, targetBranch);
  if (rebaseResult.code !== 0 || (await hasMergeConflicts(taskRoot))) {
    await updateWorktreeStatus(seedRoot, marker.worktreeId, 'conflict');
    await writeLastDeliverState(seedRoot, {
      worktreeId: marker.worktreeId,
      status: 'conflict',
      startedAt,
      finishedAt: new Date().toISOString(),
      targetBranch,
    });
    throw new MwtError({
      code: EXIT_CODES.GIT_CONFLICT,
      id: 'deliver_rebase_conflict',
      message: 'Rebase conflicted while delivering the task worktree.',
      details: {
        worktreePath: marker.worktreePath,
        recovery:
          'Resolve conflicts inside the task worktree and rerun mwt deliver --resume.',
      },
    });
  }

  const hookContext = {
    version: TOOL_STATE_VERSION,
    repoRoot: toPortablePath(seedRoot),
    seedPath: toPortablePath(seedRoot),
    defaultBranch: config.default_branch,
    defaultRemote: config.default_remote,
    worktree: {
      kind: 'task',
      name: marker.worktreeName,
      slug: marker.worktreeSlug,
      id: marker.worktreeId,
      path: marker.worktreePath,
      branch: marker.branch,
      baseBranch: marker.baseBranch,
      targetBranch,
    },
  };

  await runHooks(
    seedRoot,
    'pre_deliver',
    {
      ...hookContext,
      hookType: 'pre_deliver',
    },
    {
      yes: options.yes,
      worktreePath: taskRoot,
    },
  );

  const verifySkipped = Boolean(options.skipVerify);
  if (!verifySkipped) {
    if (!config.verify?.command) {
      throw new MwtError({
        code: EXIT_CODES.VERIFICATION_FAILURE,
        id: 'missing_verify_command',
        message: 'No verify.command is configured for delivery.',
      });
    }

    const verifyResult = await runShell(config.verify.command, {
      cwd: taskRoot,
    });
    if (verifyResult.code !== 0) {
      await updateWorktreeStatus(seedRoot, marker.worktreeId, 'active');
      await writeLastDeliverState(seedRoot, {
        worktreeId: marker.worktreeId,
        status: 'verification-failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        targetBranch,
      });
      throw new MwtError({
        code: EXIT_CODES.VERIFICATION_FAILURE,
        id: 'deliver_verify_failed',
        message: 'Verification failed during deliver.',
        details: {
          stdout: verifyResult.stdout.trim(),
          stderr: verifyResult.stderr.trim(),
        },
      });
    }
  }

  const pushResult = await pushHeadToBranch(taskRoot, remote, targetBranch);
  if (pushResult.code !== 0) {
    await updateWorktreeStatus(seedRoot, marker.worktreeId, 'active');
    await writeLastDeliverState(seedRoot, {
      worktreeId: marker.worktreeId,
      status: 'push-failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      targetBranch,
    });
    throw new MwtError({
      code: EXIT_CODES.REMOTE_SYNC_FAILURE,
      id: 'deliver_push_failed',
      message:
        `Push failed during deliver: ${pushResult.stderr || pushResult.stdout}`.trim(),
    });
  }

  const seedSync = await syncSeed(seedRoot, {
    base: targetBranch,
    allowDirtySeed: options.allowDirtySeed,
  });
  await runHooks(
    seedRoot,
    'post_deliver',
    {
      ...hookContext,
      hookType: 'post_deliver',
    },
    {
      yes: options.yes,
      worktreePath: taskRoot,
    },
  );

  await updateWorktreeStatus(seedRoot, marker.worktreeId, 'delivered');
  const pushedCommit = await getHeadCommit(taskRoot);
  await writeLastDeliverState(seedRoot, {
    worktreeId: marker.worktreeId,
    status: 'succeeded',
    startedAt,
    finishedAt: new Date().toISOString(),
    targetBranch,
    pushedCommit,
    seedSyncedTo: seedSync.after,
  });

  return {
    worktreeId: marker.worktreeId,
    targetBranch,
    pushedCommit,
    seedSyncedTo: seedSync.after,
    verifySkipped,
  };
}

function buildAllowedUntrackedSet(item = null) {
  return new Set([MWT_MARKER_FILE, ...(item?.bootstrapFiles ?? [])]);
}

async function collectUnexpectedUntracked(taskRoot, item = null) {
  const untracked = await listUntrackedChanges(taskRoot);
  const allowedUntracked = buildAllowedUntrackedSet(item);
  return untracked.filter((entry) => !allowedUntracked.has(entry));
}

async function assertTaskDropSafe(
  taskRoot,
  item = null,
  force = false,
  options = {},
) {
  if (!(await pathExists(taskRoot))) {
    return;
  }

  // The CWD check runs before the force short-circuit: on Windows, the
  // OS refuses to delete a directory that any process holds as its
  // current working directory, so --force cannot override it. Surface
  // the offending processes with a specific error instead of letting
  // the subsequent `git worktree remove` / rmdir fail with a generic
  // EBUSY further down the pipeline.
  const findHolders =
    options.findProcessesHoldingCwd ?? findProcessesHoldingCwd;
  const cwdHolders = await findHolders(taskRoot);
  if (cwdHolders.length > 0) {
    throw new MwtError({
      code: EXIT_CODES.UNSAFE_PRUNE_TARGET,
      id: 'drop_cwd_holders',
      message:
        'Cannot drop a task worktree while other processes hold it as their current working directory.',
      details: {
        taskPath: toPortablePath(taskRoot),
        holders: cwdHolders.map((holder) => ({
          pid: holder.pid,
          name: holder.name,
          cwd: toPortablePath(holder.cwd),
        })),
        recovery:
          'Return the calling shell to a directory outside the worktree, stop any background processes (sleep, dev servers, language servers) that cd into it, then rerun mwt prune.',
      },
    });
  }

  if ((await hasTrackedChanges(taskRoot)) && !force) {
    throw new MwtError({
      code: EXIT_CODES.UNSAFE_PRUNE_TARGET,
      id: 'drop_dirty_worktree',
      message:
        'Cannot drop a task worktree with tracked changes without --force semantics.',
      details: {
        changedFiles: await listTrackedChanges(taskRoot),
      },
    });
  }

  if (force) {
    return;
  }

  const unexpectedUntracked = await collectUnexpectedUntracked(taskRoot, item);
  if (unexpectedUntracked.length > 0) {
    throw new MwtError({
      code: EXIT_CODES.UNSAFE_PRUNE_TARGET,
      id: 'drop_unexpected_untracked',
      message:
        'Cannot drop a task worktree with unexpected untracked files without --force semantics.',
      details: {
        unexpectedUntracked,
      },
    });
  }
}

export async function dropTaskWorktree(taskRoot, options = {}) {
  const marker = await loadMarker(taskRoot);
  if (!marker || marker.kind !== 'task') {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'not_a_task_worktree',
      message: 'dropTaskWorktree must run against a managed task worktree.',
    });
  }

  const seedRoot = marker.repoRoot;
  const state = await readWorktreeState(seedRoot);
  const item =
    state.items.find((entry) => entry.worktreeId === marker.worktreeId) ?? null;
  const branch = item?.branch ?? marker.branch;
  const shouldDeleteBranch = options.deleteBranch === true;

  await assertTaskDropSafe(taskRoot, item, options.force === true, {
    findProcessesHoldingCwd: options.findProcessesHoldingCwd,
  });
  const cleanup = await finalizeTaskCleanup(seedRoot, {
    taskRoot,
    worktreeId: marker.worktreeId,
    branch,
    deleteBranch: shouldDeleteBranch,
    forceBranchDelete: options.forceBranchDelete !== false,
    removePath: options.removePath,
    removeWorktree: options.removeWorktree,
  });
  if (cleanup.failures.length > 0) {
    throwCleanupIncomplete({
      id: 'drop_cleanup_incomplete',
      message:
        'Managed task cleanup could not finish every requested drop step.',
      worktreeId: marker.worktreeId,
      taskName: marker.worktreeName,
      taskPath: marker.worktreePath,
      branch,
      worktreeRemoved: cleanup.worktreeRemoved,
      taskPathRemoved: cleanup.taskPathRemoved,
      branchDeleted: cleanup.branchDeleted,
      stateRemoved: cleanup.stateRemoved,
      completedSteps: cleanup.completedSteps,
      failures: cleanup.failures,
    });
  }

  return {
    worktreeId: marker.worktreeId,
    worktreeName: marker.worktreeName,
    taskPath: marker.worktreePath,
    branch,
    branchDeleted: cleanup.branchDeleted,
  };
}

export async function planDropTaskWorktree(taskRoot, options = {}) {
  const marker = await loadMarker(taskRoot);
  if (!marker || marker.kind !== 'task') {
    throw new MwtError({
      code: EXIT_CODES.TASK_POLICY_VIOLATION,
      id: 'not_a_task_worktree',
      message: 'dropTaskWorktree must run against a managed task worktree.',
    });
  }

  const seedRoot = marker.repoRoot;
  const state = await readWorktreeState(seedRoot);
  const item =
    state.items.find((entry) => entry.worktreeId === marker.worktreeId) ?? null;
  const branch = item?.branch ?? marker.branch;
  const shouldDeleteBranch = options.deleteBranch === true;

  await assertTaskDropSafe(taskRoot, item, options.force === true, {
    findProcessesHoldingCwd: options.findProcessesHoldingCwd,
  });

  return {
    dryRun: true,
    worktreeId: marker.worktreeId,
    worktreeName: marker.worktreeName,
    taskPath: marker.worktreePath,
    branch,
    branchDeleted: shouldDeleteBranch && Boolean(branch),
    actions: [
      {
        id: 'drop_worktree',
        description: `Remove ${marker.worktreeName} at ${marker.worktreePath}.`,
      },
      ...(shouldDeleteBranch && branch
        ? [
            {
              id: 'drop_branch',
              description: `Delete local branch ${branch}.`,
            },
          ]
        : []),
    ],
  };
}

export async function planPruneWorktrees(seedRoot, options = {}) {
  const state = await readWorktreeState(seedRoot);
  const eligible = [];
  const blocked = [];

  for (const item of state.items) {
    const shouldPruneDelivered = options.merged && item.status === 'delivered';
    const shouldPruneAbandoned =
      options.abandoned && item.status === 'abandoned';
    if (!(shouldPruneDelivered || shouldPruneAbandoned)) {
      continue;
    }

    const marker = await loadMarker(item.path);
    if (!marker || marker.kind !== 'task') {
      blocked.push({
        worktreeId: item.worktreeId,
        name: item.name,
        reason: 'missing_task_marker',
      });
      continue;
    }

    const pathExistsNow = await pathExists(item.path);
    let unexpectedUntracked = [];
    let trackedDirty = false;
    if (pathExistsNow) {
      trackedDirty = await hasTrackedChanges(item.path);
      const untracked = await listUntrackedChanges(item.path);
      const allowedUntracked = new Set([
        MWT_MARKER_FILE,
        ...(item.bootstrapFiles ?? []),
      ]);
      unexpectedUntracked = untracked.filter(
        (entry) => !allowedUntracked.has(entry),
      );
    }

    if (!options.force && (trackedDirty || unexpectedUntracked.length > 0)) {
      blocked.push({
        worktreeId: item.worktreeId,
        name: item.name,
        reason: trackedDirty ? 'tracked_dirty' : 'unexpected_untracked',
        unexpectedUntracked,
      });
      continue;
    }

    eligible.push({
      worktreeId: item.worktreeId,
      name: item.name,
      path: item.path,
      branch: item.branch,
      branchDeleted: options.withBranches
        ? await isBranchMerged(seedRoot, item.branch, marker.targetBranch)
        : false,
    });
  }

  return {
    dryRun: true,
    eligible,
    blocked,
    actions: eligible.map((item) => ({
      id: 'prune_worktree',
      description: `Remove ${item.name} at ${item.path}${item.branchDeleted ? ' and delete its merged local branch.' : '.'}`,
    })),
  };
}

export async function pruneWorktrees(seedRoot, options = {}) {
  const state = await readWorktreeState(seedRoot);
  const pruned = [];
  const failures = [];

  for (const item of state.items) {
    const shouldPruneDelivered = options.merged && item.status === 'delivered';
    const shouldPruneAbandoned =
      options.abandoned && item.status === 'abandoned';
    if (!(shouldPruneDelivered || shouldPruneAbandoned)) {
      continue;
    }

    if (
      item.status === 'active' ||
      item.status === 'delivering' ||
      item.status === 'conflict'
    ) {
      continue;
    }

    const marker = await loadMarker(item.path);
    if (!marker || marker.kind !== 'task') {
      continue;
    }

    if (await pathExists(item.path)) {
      await assertTaskDropSafe(item.path, item, options.force, {
        findProcessesHoldingCwd: options.findProcessesHoldingCwd,
      });
    }

    const canDeleteBranch = options.withBranches
      ? await isBranchMerged(seedRoot, item.branch, marker.targetBranch)
      : false;
    const cleanup = await finalizeTaskCleanup(seedRoot, {
      taskRoot: item.path,
      worktreeId: item.worktreeId,
      branch: item.branch,
      deleteBranch: canDeleteBranch,
      forceBranchDelete: options.force === true,
      removePath: options.removePath,
      removeWorktree: options.removeWorktree,
    });
    if (cleanup.stateRemoved) {
      pruned.push({
        worktreeId: item.worktreeId,
        name: item.name,
        branchDeleted: cleanup.branchDeleted,
      });
    }
    if (cleanup.failures.length > 0) {
      failures.push({
        worktreeId: item.worktreeId,
        name: item.name,
        taskPath: toPortablePath(item.path),
        branch: item.branch,
        worktreeRemoved: cleanup.worktreeRemoved,
        taskPathRemoved: cleanup.taskPathRemoved,
        branchDeleted: cleanup.branchDeleted,
        stateRemoved: cleanup.stateRemoved,
        completedSteps: cleanup.completedSteps,
        failures: cleanup.failures,
      });
    }
  }

  if (failures.length > 0) {
    throw new MwtError({
      code: EXIT_CODES.UNSAFE_PRUNE_TARGET,
      id: 'prune_cleanup_incomplete',
      message:
        'Prune removed some managed task state but could not finish every cleanup step.',
      details: {
        pruned,
        failures,
        recovery:
          'Resolve the blocking cleanup failure, then rerun mwt prune or mwt doctor --deep --fix.',
      },
    });
  }

  return {
    pruned,
  };
}

function getSiblingTaskPrefix(seedRoot) {
  return `${path.basename(seedRoot)}-wt-`;
}

async function listSiblingTaskDirectories(seedRoot) {
  const parentDir = path.dirname(seedRoot);
  const prefix = getSiblingTaskPrefix(seedRoot);
  const entries = await readdir(parentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(parentDir, entry.name));
}

async function isEmptyDirectory(targetPath) {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  try {
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function removeEmptyDirectoryIfPresent(
  targetPath,
  removePathImpl = removePath,
) {
  if (!(await isEmptyDirectory(targetPath))) {
    return false;
  }

  await removePathImpl(targetPath);
  return !(await pathExists(targetPath));
}

function throwDoctorFixIncomplete({
  issues,
  appliedActions,
  completedSteps,
  failures,
}) {
  throw new MwtError({
    code: EXIT_CODES.GENERIC_FAILURE,
    id: 'doctor_fix_incomplete',
    message:
      'Doctor repaired some managed-worktree state but could not finish every requested fix.',
    details: {
      issues,
      appliedActions,
      completedSteps,
      failures,
      recovery:
        'Resolve the blocking cleanup failure, then rerun mwt doctor --fix or mwt doctor --deep --fix.',
    },
  });
}

async function assessDoctorRepository(seedRoot, options = {}) {
  const managedPaths = getManagedPaths(seedRoot);
  if (
    !(await pathExists(managedPaths.configPath)) ||
    !(await pathExists(managedPaths.markerPath))
  ) {
    throw new MwtError({
      code: EXIT_CODES.NOT_INITIALIZED,
      id: 'not_initialized',
      message: 'Repository is not initialized for managed-worktree-system.',
    });
  }

  const issues = [];
  const actions = [];
  const state = await readWorktreeState(seedRoot);
  const listed = (await worktreeList(seedRoot)).filter((entry) => !entry.bare);
  const listedPaths = new Set(listed.map((entry) => path.resolve(entry.path)));
  const nextItems = [];
  const config = options.fix ? await loadConfig(seedRoot) : null;
  const completedSteps = [];
  const failures = [];
  const pendingStateActions = [];
  const removeDoctorPath = options.removePath ?? removePath;

  for (const item of state.items) {
    if (!listedPaths.has(path.resolve(item.path))) {
      issues.push({
        id: 'stale_registry_entry',
        severity: 'warning',
        message: `Registry contains stale worktree entry: ${item.name}`,
        details: { path: item.path, branch: item.branch },
      });

      if (options.fix) {
        const pathExistsBeforeFix = await pathExists(item.path);
        let pathCleared = !pathExistsBeforeFix;
        try {
          if (
            pathExistsBeforeFix &&
            (await removeEmptyDirectoryIfPresent(item.path, removeDoctorPath))
          ) {
            recordCleanupAction(
              actions,
              completedSteps,
              {
                id: 'remove_empty_stale_worktree_dir',
                path: toPortablePath(item.path),
              },
              `remove_empty_stale_worktree_dir: ${toPortablePath(item.path)}`,
            );
            pathCleared = true;
          }
        } catch (error) {
          pushCleanupFailure(
            failures,
            'remove_empty_stale_worktree_dir',
            error,
            { path: toPortablePath(item.path) },
          );
        }
        pathCleared ||= !(await pathExists(item.path));
        if (config && item.branch) {
          const divergence = await getAheadBehind(
            seedRoot,
            item.branch,
            config.default_branch,
          );
          if (divergence && divergence.ahead === 0) {
            const deleteResult = await deleteBranch(
              seedRoot,
              item.branch,
              true,
            );
            const branchDeleted =
              deleteResult.code === 0 ||
              !(await branchExists(seedRoot, item.branch));
            if (branchDeleted) {
              recordCleanupAction(
                actions,
                completedSteps,
                {
                  id: 'delete_stale_branch',
                  branch: item.branch,
                },
                `delete_stale_branch: ${item.branch}`,
              );
            } else {
              pushCleanupFailure(
                failures,
                'delete_stale_branch',
                deleteResult,
                {
                  branch: item.branch,
                },
              );
            }
          }
        }
        if (pathCleared) {
          pendingStateActions.push({
            id: 'remove_stale_registry_entry',
            worktreeId: item.worktreeId,
          });
        } else {
          nextItems.push(item);
        }
        continue;
      }
    }

    nextItems.push(item);
  }

  for (const listedEntry of listed) {
    const marker = await loadMarker(listedEntry.path);
    if (
      marker?.kind === 'task' &&
      !state.items.some((item) => item.worktreeId === marker.worktreeId)
    ) {
      issues.push({
        id: 'missing_registry_entry',
        severity: 'warning',
        message: `Managed task worktree is missing from registry: ${marker.worktreeName}`,
        details: { path: marker.worktreePath },
      });

      if (options.fix) {
        nextItems.push({
          worktreeId: marker.worktreeId,
          name: marker.worktreeName,
          branch: marker.branch,
          path: marker.worktreePath,
          status: 'active',
        });
        pendingStateActions.push({
          id: 'add_missing_registry_entry',
          worktreeId: marker.worktreeId,
        });
      }
    }
  }

  if (options.deep) {
    if (await isBareRepository(seedRoot)) {
      issues.push({
        id: 'unexpected_bare_repository',
        severity: 'error',
        message:
          'The seed repository is bare, but mwt requires a normal non-bare seed checkout.',
      });
    }

    const gitDir = await getGitDir(seedRoot);
    if (gitDir !== '.git') {
      issues.push({
        id: 'unexpected_git_dir',
        severity: 'error',
        message: 'The seed repository is not using a normal .git directory.',
        details: {
          gitDir,
        },
      });
    }

    const locks = await listLocks(seedRoot);
    for (const lockRecord of locks) {
      issues.push(lockIssueFromRecord(lockRecord));
    }

    const siblingDirs = await listSiblingTaskDirectories(seedRoot);
    for (const siblingDir of siblingDirs) {
      if (listedPaths.has(path.resolve(siblingDir))) {
        continue;
      }

      const marker = await loadMarker(siblingDir);
      issues.push({
        id:
          marker?.kind === 'task'
            ? 'orphan_managed_sibling'
            : 'orphan_unmanaged_sibling',
        severity: 'warning',
        message:
          marker?.kind === 'task'
            ? `Managed-looking sibling directory is not registered as a live Git worktree: ${path.basename(siblingDir)}`
            : `Sibling directory matches the managed naming pattern but is not a live managed worktree: ${path.basename(siblingDir)}`,
        details: {
          path: toPortablePath(siblingDir),
        },
      });

      if (options.fix) {
        try {
          if (await removeEmptyDirectoryIfPresent(siblingDir)) {
            recordCleanupAction(
              actions,
              completedSteps,
              {
                id: 'remove_orphan_sibling_dir',
                path: toPortablePath(siblingDir),
              },
              `remove_orphan_sibling_dir: ${toPortablePath(siblingDir)}`,
            );
          }
        } catch (error) {
          pushCleanupFailure(failures, 'remove_orphan_sibling_dir', error, {
            path: toPortablePath(siblingDir),
          });
        }
      }
    }
  }

  if (options.fix) {
    nextItems.sort((left, right) => left.name.localeCompare(right.name));
    try {
      await writeWorktreeState(seedRoot, {
        version: TOOL_STATE_VERSION,
        items: nextItems,
      });
      for (const action of pendingStateActions) {
        const summary =
          action.id === 'remove_stale_registry_entry'
            ? `remove_stale_registry_entry: ${action.worktreeId}`
            : `add_missing_registry_entry: ${action.worktreeId}`;
        recordCleanupAction(actions, completedSteps, action, summary);
      }
    } catch (error) {
      pushCleanupFailure(failures, 'write_worktree_state', error, {
        path: toPortablePath(managedPaths.worktreeStatePath),
      });
    }

    if (!(await pathExists(managedPaths.seedStatePath))) {
      try {
        const config = await loadConfig(seedRoot);
        await writeSeedState(seedRoot, {
          branch: await getCurrentBranch(seedRoot),
          remote: config.default_remote,
          lastSyncAt: null,
          lastSyncCommit: await getHeadCommit(seedRoot),
          status: 'healthy',
        });
        recordCleanupAction(
          actions,
          completedSteps,
          { id: 'rebuild_seed_state' },
          'rebuild_seed_state',
        );
      } catch (error) {
        pushCleanupFailure(failures, 'rebuild_seed_state', error, {
          path: toPortablePath(managedPaths.seedStatePath),
        });
      }
    }

    if (options.deep) {
      try {
        const clearedLocks = await clearExpiredLocks(seedRoot);
        for (const scope of clearedLocks) {
          recordCleanupAction(
            actions,
            completedSteps,
            {
              id: 'clear_expired_lock',
              scope,
            },
            `clear_expired_lock: ${scope}`,
          );
        }
      } catch (error) {
        pushCleanupFailure(failures, 'clear_expired_lock', error, {
          path: toPortablePath(managedPaths.locksDir),
        });
      }
    }

    if (failures.length > 0) {
      throwDoctorFixIncomplete({
        issues,
        appliedActions: actions,
        completedSteps,
        failures,
      });
    }
  }

  return {
    initialized: true,
    issues,
    actions,
  };
}

export async function planDoctorRepository(seedRoot, options = {}) {
  const assessment = await assessDoctorRepository(seedRoot, {
    deep: options.deep,
    fix: false,
  });
  const plannedFixes = [];
  const config = options.fix ? await loadConfig(seedRoot) : null;

  if (options.fix) {
    for (const issue of assessment.issues) {
      if (issue.id === 'stale_registry_entry') {
        const issuePath = issue.details?.path;
        const issuePathExists =
          typeof issuePath === 'string' && (await pathExists(issuePath));
        const issuePathIsEmpty =
          issuePathExists && (await isEmptyDirectory(issuePath));
        if (!issuePathExists || issuePathIsEmpty) {
          plannedFixes.push({
            id: 'remove_stale_registry_entry',
            description: issue.message,
          });
        }
        if (issuePathIsEmpty) {
          plannedFixes.push({
            id: 'remove_empty_stale_worktree_dir',
            description: `Remove the empty stale worktree directory at ${issuePath}.`,
          });
        }
        const branch = issue.details?.branch;
        if (config && typeof branch === 'string' && branch.trim()) {
          const divergence = await getAheadBehind(
            seedRoot,
            branch,
            config.default_branch,
          );
          if (divergence && divergence.ahead === 0) {
            plannedFixes.push({
              id: 'delete_stale_branch',
              description: `Delete the stale local branch ${branch} because it has no unique commits beyond ${config.default_branch}.`,
            });
          }
        }
      } else if (issue.id === 'missing_registry_entry') {
        plannedFixes.push({
          id: 'add_missing_registry_entry',
          description: issue.message,
        });
      } else if (
        issue.id === 'orphan_managed_sibling' ||
        issue.id === 'orphan_unmanaged_sibling'
      ) {
        const issuePath = issue.details?.path;
        if (
          typeof issuePath === 'string' &&
          (await isEmptyDirectory(issuePath))
        ) {
          plannedFixes.push({
            id: 'remove_orphan_sibling_dir',
            description: `Remove the empty orphan sibling directory at ${issuePath}.`,
          });
        }
      } else if (issue.id === 'stale_lock') {
        plannedFixes.push({
          id: 'clear_expired_lock',
          description: issue.message,
        });
      }
    }
  }

  return {
    ...assessment,
    dryRun: true,
    plannedFixes,
  };
}

export async function doctorRepository(seedRoot, options = {}) {
  return assessDoctorRepository(seedRoot, options);
}
