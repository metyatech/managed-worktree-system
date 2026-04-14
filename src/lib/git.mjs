import { MwtError } from './errors.mjs';
import { runProcess } from './process.mjs';

export async function git(args, options = {}) {
  return runProcess('git', args, options);
}

export async function gitOk(args, options = {}, errorFactory = undefined) {
  const result = await git(args, options);
  if (result.code !== 0) {
    if (typeof errorFactory === 'function') {
      throw errorFactory(result);
    }

    throw new MwtError({
      message: `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`.trim(),
    });
  }

  return result;
}

export async function getRepoRoot(cwd) {
  const result = await gitOk(['rev-parse', '--show-toplevel'], { cwd });
  return result.stdout.trim();
}

export async function getGitDir(cwd) {
  const result = await gitOk(['rev-parse', '--git-dir'], { cwd });
  return result.stdout.trim();
}

export async function getGitPath(cwd, relativePath) {
  const result = await gitOk(['rev-parse', '--git-path', relativePath], { cwd });
  return result.stdout.trim();
}

export async function isBareRepository(cwd) {
  const result = await gitOk(['rev-parse', '--is-bare-repository'], { cwd });
  return result.stdout.trim() === 'true';
}

export async function getCurrentBranch(cwd) {
  const result = await gitOk(['branch', '--show-current'], { cwd });
  return result.stdout.trim();
}

export async function getHeadCommit(cwd) {
  const result = await gitOk(['rev-parse', 'HEAD'], { cwd });
  return result.stdout.trim();
}

export async function hasTrackedChanges(cwd) {
  const result = await gitOk(
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd },
  );
  return result.stdout.trim().length > 0;
}

export async function listTrackedChanges(cwd) {
  const result = await gitOk(
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd },
  );

  return result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export async function listUntrackedChanges(cwd) {
  const result = await gitOk(
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd },
  );

  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
}

export async function hasMergeConflicts(cwd) {
  const result = await gitOk(['diff', '--name-only', '--diff-filter=U'], { cwd });
  return result.stdout.trim().length > 0;
}

export async function fetchBranch(cwd, remote, branch) {
  return gitOk(['fetch', remote, branch], { cwd });
}

export async function fastForwardBranch(cwd, remote, branch) {
  return git(['merge', '--ff-only', `${remote}/${branch}`], { cwd });
}

export async function rebaseOnto(cwd, remote, branch) {
  return git(['rebase', `${remote}/${branch}`], { cwd });
}

export async function pushHeadToBranch(cwd, remote, branch) {
  return git(['push', remote, `HEAD:${branch}`], { cwd });
}

export async function worktreeList(cwd) {
  const result = await gitOk(['worktree', 'list', '--porcelain'], { cwd });
  const chunks = result.stdout.trim().split(/\r?\n\r?\n/u).filter(Boolean);

  return chunks.map((chunk) => {
    const lines = chunk.split(/\r?\n/u);
    const entry = {
      path: '',
      branch: null,
      head: null,
      bare: false,
      detached: false,
      prunable: false,
    };

    for (const line of lines) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ').trim();
      if (key === 'worktree') {
        entry.path = value;
      } else if (key === 'branch') {
        entry.branch = value.replace('refs/heads/', '');
      } else if (key === 'HEAD') {
        entry.head = value;
      } else if (key === 'bare') {
        entry.bare = true;
      } else if (key === 'detached') {
        entry.detached = true;
      } else if (key === 'prunable') {
        entry.prunable = true;
      }
    }

    return entry;
  });
}

export async function addWorktree(cwd, worktreePath, branch, startPoint) {
  return git([
    'worktree',
    'add',
    worktreePath,
    '-b',
    branch,
    startPoint,
  ], { cwd });
}

export async function updateSubmodules(cwd) {
  return git(['submodule', 'update', '--init', '--recursive'], { cwd });
}

export async function removeWorktree(cwd, worktreePath, force = false) {
  const args = ['worktree', 'remove', worktreePath];
  if (force) {
    args.splice(2, 0, '--force');
  }

  return git(args, { cwd });
}

export async function deleteBranch(cwd, branch, force = false) {
  return git(['branch', force ? '-D' : '-d', branch], { cwd });
}

export async function branchExists(cwd, branch) {
  const result = await git(['branch', '--list', branch], { cwd });
  if (result.code !== 0) {
    return false;
  }

  return result.stdout.trim().length > 0;
}

export async function isBranchMerged(cwd, branch, target) {
  const result = await git(['branch', '--merged', target], { cwd });
  if (result.code !== 0) {
    return false;
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[*+ ]+/u, '').trim())
    .includes(branch);
}

export async function getUpstreamBranch(cwd) {
  const result = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd });
  if (result.code !== 0) {
    return null;
  }

  return result.stdout.trim();
}

export async function getAheadBehind(cwd, branchA, branchB) {
  const result = await git(['rev-list', '--left-right', '--count', `${branchA}...${branchB}`], { cwd });
  if (result.code !== 0) {
    return null;
  }

  const [ahead, behind] = result.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10));
  return {
    ahead,
    behind,
  };
}
