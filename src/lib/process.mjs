import { spawn } from 'node:child_process';

export async function runProcess(file, args, options = {}) {
  const {
    cwd,
    env,
    input,
    shell = false,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell,
      stdio: 'pipe',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }

    child.stdin.end();
  });
}

export async function runShell(command, options = {}) {
  return runProcess(command, [], {
    ...options,
    shell: true,
  });
}
