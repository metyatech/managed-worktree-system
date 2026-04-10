import { randomUUID } from 'node:crypto';
import { open, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LOCK_TTL_MS,
  EXIT_CODES,
  LOCKS_DIR,
  TOOL_STATE_VERSION,
} from './constants.mjs';
import { MwtError } from './errors.mjs';
import { ensureDir, pathExists, readJson, toPortablePath } from './fs.mjs';

function getLockPath(seedRoot, scope) {
  return path.join(seedRoot, LOCKS_DIR, `${scope}.json`);
}

function isExpired(lockRecord) {
  if (!lockRecord?.expiresAt) {
    return false;
  }

  return Date.parse(lockRecord.expiresAt) <= Date.now();
}

export async function readLock(seedRoot, scope) {
  const lockPath = getLockPath(seedRoot, scope);
  if (!(await pathExists(lockPath))) {
    return null;
  }

  return readJson(lockPath);
}

export async function listLocks(seedRoot) {
  const locksDir = path.join(seedRoot, LOCKS_DIR);
  if (!(await pathExists(locksDir))) {
    return [];
  }

  const entries = await readdir(locksDir, {
    withFileTypes: true,
  });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const scope = entry.name.replace(/\.json$/u, '');
    const record = await readLock(seedRoot, scope);
    if (record) {
      items.push(record);
    }
  }

  return items;
}

export async function acquireLock(seedRoot, scope, metadata = {}, options = {}) {
  const lockPath = getLockPath(seedRoot, scope);
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  await ensureDir(path.dirname(lockPath));

  const record = {
    version: TOOL_STATE_VERSION,
    scope,
    token: randomUUID(),
    seedRoot: toPortablePath(seedRoot),
    command: metadata.command ?? 'unknown',
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }

      return {
        ...record,
        lockPath,
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const existing = await readLock(seedRoot, scope);
      if (existing && isExpired(existing)) {
        await rm(lockPath, { force: true });
        continue;
      }

      throw new MwtError({
        code: EXIT_CODES.OPERATION_LOCKED,
        id: 'operation_locked',
        message: `Another managed-worktree-system operation is already running for this repository.`,
        details: {
          scope,
          activeLock: existing,
          recovery: 'Wait for the active operation to finish, or use mwt doctor --deep --fix to clear expired lock files.',
        },
      });
    }
  }

  throw new MwtError({
    code: EXIT_CODES.OPERATION_LOCKED,
    id: 'operation_locked',
    message: 'Could not acquire the repository operation lock.',
    details: {
      scope,
    },
  });
}

export async function releaseLock(lockRecord) {
  if (!lockRecord?.lockPath) {
    return;
  }

  await rm(lockRecord.lockPath, { force: true });
}

export async function withLock(seedRoot, scope, metadata, fn, options = {}) {
  const lockRecord = await acquireLock(seedRoot, scope, metadata, options);
  try {
    return await fn(lockRecord);
  } finally {
    await releaseLock(lockRecord);
  }
}

export function lockIssueFromRecord(lockRecord) {
  return {
    id: isExpired(lockRecord) ? 'stale_lock' : 'active_lock',
    severity: isExpired(lockRecord) ? 'warning' : 'info',
    message: isExpired(lockRecord)
      ? `Stale operation lock is present for ${lockRecord.command}.`
      : `Active operation lock is present for ${lockRecord.command}.`,
    details: {
      scope: lockRecord.scope,
      command: lockRecord.command,
      pid: lockRecord.pid,
      host: lockRecord.host,
      acquiredAt: lockRecord.acquiredAt,
      expiresAt: lockRecord.expiresAt,
    },
  };
}

export async function clearExpiredLocks(seedRoot) {
  const locks = await listLocks(seedRoot);
  const cleared = [];

  for (const lockRecord of locks) {
    if (!isExpired(lockRecord)) {
      continue;
    }

    await rm(getLockPath(seedRoot, lockRecord.scope), { force: true });
    cleared.push(lockRecord.scope);
  }

  return cleared;
}
