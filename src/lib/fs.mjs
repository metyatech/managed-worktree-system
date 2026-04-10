import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export async function removePath(targetPath) {
  await rm(targetPath, {
    recursive: true,
    force: true,
  });
}

export function toPortablePath(value) {
  return value.replaceAll('\\', '/');
}
