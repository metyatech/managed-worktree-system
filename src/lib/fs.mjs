import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WINDOWS_REMOVE_PATH_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000];

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback = undefined) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (fallback !== undefined && error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readText(filePath, fallback = undefined) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (fallback !== undefined && error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, value, 'utf8');
}

function shouldRetryRemovePathError(error, platform) {
  return platform === 'win32' && (
    error?.code === 'EBUSY' ||
    error?.code === 'EPERM' ||
    error?.code === 'ENOTEMPTY'
  );
}

async function removePathImpl(targetPath) {
  await rm(targetPath, {
    recursive: true,
    force: true,
  });
}

export async function removePath(targetPath, options = {}) {
  const removeImpl = options.removeImpl ?? removePathImpl;
  const retryDelaysMs = options.retryDelaysMs ?? WINDOWS_REMOVE_PATH_RETRY_DELAYS_MS;
  const platform = options.platform ?? process.platform;
  const waitImpl = options.waitImpl ?? delay;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeImpl(targetPath);
      return;
    } catch (error) {
      if (!(await pathExists(targetPath))) {
        return;
      }

      if (
        !shouldRetryRemovePathError(error, platform) ||
        attempt >= retryDelaysMs.length
      ) {
        throw error;
      }

      const waitMs = retryDelaysMs[attempt];
      if (waitMs > 0) {
        await waitImpl(waitMs);
      }
    }
  }
}

export function toPortablePath(value) {
  return value.replaceAll('\\', '/');
}
