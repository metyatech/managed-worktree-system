export const TOOL_NAME = 'mwt';
export const TOOL_STATE_VERSION = 1;

export const MWT_DIR = '.mwt';
export const MWT_CONFIG_FILE = '.mwt/config.toml';
export const MWT_STATE_DIR = '.mwt/state';
export const MWT_LOG_DIR = '.mwt/logs';
export const MWT_TEMPLATE_DIR = '.mwt/templates';
export const MWT_HOOK_DIR = '.mwt/hooks';
export const MWT_MARKER_FILE = '.mwt-worktree.json';

export const HOOK_APPROVALS_FILE = `${MWT_STATE_DIR}/hook-approvals.json`;
export const LOCKS_DIR = `${MWT_STATE_DIR}/locks`;
export const SEED_STATE_FILE = `${MWT_STATE_DIR}/seed.json`;
export const WORKTREE_STATE_FILE = `${MWT_STATE_DIR}/worktrees.json`;
export const LAST_DELIVER_STATE_FILE = `${MWT_STATE_DIR}/last-deliver.json`;
export const LAST_SYNC_STATE_FILE = `${MWT_STATE_DIR}/last-sync.json`;
export const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  GENERIC_FAILURE: 1,
  INVALID_USAGE: 2,
  NOT_INITIALIZED: 3,
  SEED_POLICY_VIOLATION: 4,
  TASK_POLICY_VIOLATION: 5,
  HOOK_FAILURE: 6,
  VERIFICATION_FAILURE: 7,
  GIT_CONFLICT: 8,
  REMOTE_SYNC_FAILURE: 9,
  WORKTREE_NOT_FOUND: 10,
  UNSAFE_PRUNE_TARGET: 11,
  UNSUPPORTED_INIT_STATE: 12,
  OPERATION_LOCKED: 13,
});

export const DEFAULT_BOOTSTRAP_PROFILE = 'local';

export const DEFAULT_IGNORED_ENTRIES = [
  '.mwt-worktree.json',
  '.mwt/state/',
  '.mwt/logs/',
];

export const SUPPORTED_COMMANDS = [
  'init',
  'create',
  'list',
  'deliver',
  'sync',
  'drop',
  'prune',
  'doctor',
  'version',
];
