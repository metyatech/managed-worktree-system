export declare const TOOL_NAME: string;
export declare const MWT_MARKER_FILE: string;
export declare const EXIT_CODES: Readonly<Record<string, number>>;

export declare class MwtError extends Error {
  code: number;
  id: string;
  details: unknown;
}

export interface MwtMarker {
  version: number;
  kind: 'seed' | 'task';
  repoId: string;
  repoRoot: string;
  worktreeName?: string;
  worktreeSlug?: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  targetBranch?: string;
  createdAt?: string;
  createdBy?: string;
  defaultBranch?: string;
  defaultRemote?: string;
}

export interface CreateTaskWorktreeOptions {
  base?: string;
  target?: string;
  bootstrap?: boolean;
  copyProfile?: string;
  yes?: boolean;
  createdBy?: string;
  pathTemplate?: string;
  branchTemplate?: string;
}

export interface CreateTaskWorktreeResult {
  worktreeName: string;
  worktreeSlug: string;
  worktreeId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  targetBranch: string;
  bootstrapProfile: string;
  copiedFiles: string[];
  marker: MwtMarker;
}

export interface DeliverTaskWorktreeOptions {
  target?: string;
  skipVerify?: boolean;
  allowDirtyTask?: boolean;
  resume?: boolean;
  yes?: boolean;
}

export interface DeliverTaskWorktreeResult {
  worktreeId: string;
  targetBranch: string;
  pushedCommit: string;
  seedSyncedTo: string;
  verifySkipped: boolean;
}

export interface DropTaskWorktreeOptions {
  force?: boolean;
  deleteBranch?: boolean;
  forceBranchDelete?: boolean;
}

export interface DropTaskWorktreeResult {
  worktreeId: string;
  worktreeName: string;
  taskPath: string;
  branch: string | null | undefined;
  branchDeleted: boolean;
}

export interface FindTaskResult {
  worktreeId: string;
  name: string;
  branch: string;
  path: string;
  status: string;
  bootstrapFiles?: string[];
}

export interface WorktreeListItem {
  path: string;
  branch: string | null;
  head: string | null;
  kind: 'seed' | 'task' | 'external';
  managedStatus: string;
  dirtyTracked: boolean;
  upstream: string | null;
  divergence: { ahead: number; behind: number } | null;
}

export interface DoctorResult {
  initialized: boolean;
  issues: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
}

export interface SyncSeedResult {
  branch: string;
  remote: string;
  before: string;
  after: string;
}

export interface InitResult {
  initialized: true;
  config: Record<string, unknown>;
  seedMarker: MwtMarker;
  seedRoot: string;
}

export declare function detectContext(cwd?: string): Promise<{
  cwd: string;
  worktreeRoot: string;
  marker: MwtMarker | null;
  seedRoot: string;
}>;
export declare function loadConfig(seedRoot: string): Promise<Record<string, unknown>>;
export declare function loadMarker(worktreeRoot: string): Promise<MwtMarker | null>;
export declare function initializeRepository(seedRoot: string, options?: Record<string, unknown>): Promise<InitResult>;
export declare function createTaskWorktree(seedRoot: string, taskName: string, options?: CreateTaskWorktreeOptions): Promise<CreateTaskWorktreeResult>;
export declare function deliverTaskWorktree(taskRoot: string, options?: DeliverTaskWorktreeOptions): Promise<DeliverTaskWorktreeResult>;
export declare function dropTaskWorktree(taskRoot: string, options?: DropTaskWorktreeOptions): Promise<DropTaskWorktreeResult>;
export declare function findTaskByName(seedRoot: string, name: string): Promise<FindTaskResult>;
export declare function listWorktrees(seedRoot: string, options?: Record<string, unknown>): Promise<WorktreeListItem[]>;
export declare function syncSeed(seedRoot: string, options?: Record<string, unknown>): Promise<SyncSeedResult>;
export declare function pruneWorktrees(seedRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function doctorRepository(seedRoot: string, options?: Record<string, unknown>): Promise<DoctorResult>;
export declare function planInitializeRepository(seedRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function planCreateTaskWorktree(seedRoot: string, taskName: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function planDeliverTaskWorktree(taskRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function planDropTaskWorktree(taskRoot: string, options?: DropTaskWorktreeOptions): Promise<Record<string, unknown>>;
export declare function planPruneWorktrees(seedRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function planDoctorRepository(seedRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function planSyncSeed(seedRoot: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
