#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import {
  EXIT_CODES,
  SUPPORTED_COMMANDS,
  TOOL_NAME,
} from './lib/constants.mjs';
import { asMwtError, MwtError } from './lib/errors.mjs';
import {
  createTaskWorktree,
  deliverTaskWorktree,
  detectContext,
  doctorRepository,
  findTaskByName,
  initializeRepository,
  listWorktrees,
  planCreateTaskWorktree,
  planDeliverTaskWorktree,
  planDoctorRepository,
  planInitializeRepository,
  planPruneWorktrees,
  planSyncSeed,
  pruneWorktrees,
  syncSeed,
} from './lib/repo.mjs';
import { toPortablePath, writeJson } from './lib/fs.mjs';
import { withLock } from './lib/locks.mjs';

const HELP_TEXT = `${TOOL_NAME} - managed Git worktree CLI

Usage:
  mwt <command> [options]

Commands:
  init       Initialize the current repository for managed-worktree-system
  create     Create a managed sibling task worktree
  list       List Git worktrees and managed metadata
  deliver    Deliver a managed task worktree to its target branch
  sync       Fast-forward the seed worktree from its configured remote branch
  prune      Remove managed task worktrees that are safe to prune
  doctor     Validate and optionally repair managed-worktree metadata
  version    Print the current CLI version
`;

const COMMAND_HELP = {
  init: `Usage: mwt init [--base <branch>] [--remote <name>] [--force] [--json]
Example: mwt init --base main --remote origin --json
`,
  create: `Usage: mwt create <name> [--base <branch>] [--copy-profile <profile>] [--run-bootstrap|--no-bootstrap] [--json]
Example: mwt create feature-auth --base main --json
`,
  list: `Usage: mwt list [--all] [--kind <seed|task>] [--status <status>] [--json]
Example: mwt list --kind task --status active --json
`,
  deliver: `Usage: mwt deliver [<name>] [--target <branch>] [--allow-dirty-task] [--resume] [--json]
Example: mwt deliver feature-auth --target main --json
`,
  sync: `Usage: mwt sync [--base <branch>] [--json]
Example: mwt sync --base main --json
`,
  prune: `Usage: mwt prune [--merged] [--abandoned] [--force] [--with-branches] [--json]
Example: mwt prune --merged --with-branches --json
`,
  doctor: `Usage: mwt doctor [--fix] [--deep] [--json]
Example: mwt doctor --fix --json
`,
};

function log(stderr, message) {
  stderr.write(`${message}\n`);
}

async function getVersion() {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  return packageJson.version;
}

function detectOutputOptions(args) {
  let output = undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      output = args[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length);
    }
  }

  return {
    json: args.includes('--json'),
    quiet: args.includes('--quiet'),
    output,
  };
}

function resolveInvocation(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return {
      mode: 'help',
      outputOptions: detectOutputOptions(args),
    };
  }

  if (args.includes('--version') || args.includes('-V')) {
    return {
      mode: 'version',
      outputOptions: detectOutputOptions(args),
    };
  }

  const commandIndex = args.findIndex((argument) => SUPPORTED_COMMANDS.includes(argument));
  if (commandIndex === -1) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'unknown_command',
      message: `Unknown command: ${args[0]}`,
      details: {
        supportedCommands: SUPPORTED_COMMANDS,
      },
    });
  }

  const command = args[commandIndex];
  const commandArgs = [
    ...args.slice(0, commandIndex),
    ...args.slice(commandIndex + 1),
  ];

  return {
    mode: 'command',
    command,
    commandArgs,
    outputOptions: detectOutputOptions(commandArgs),
  };
}

function parseCommandOptions(command, args) {
  const shared = {
    json: { type: 'boolean' },
    output: { type: 'string' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    quiet: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  };

  const optionsByCommand = {
    init: {
      ...shared,
      base: { type: 'string' },
      remote: { type: 'string' },
      force: { type: 'boolean' },
    },
    create: {
      ...shared,
      base: { type: 'string' },
      name: { type: 'string' },
      'copy-profile': { type: 'string' },
      'run-bootstrap': { type: 'boolean' },
      'no-bootstrap': { type: 'boolean' },
    },
    list: {
      ...shared,
      all: { type: 'boolean' },
      kind: { type: 'string' },
      status: { type: 'string' },
    },
    deliver: {
      ...shared,
      target: { type: 'string' },
      'allow-dirty-task': { type: 'boolean' },
      resume: { type: 'boolean' },
    },
    sync: {
      ...shared,
      base: { type: 'string' },
    },
    prune: {
      ...shared,
      merged: { type: 'boolean' },
      abandoned: { type: 'boolean' },
      force: { type: 'boolean' },
      'with-branches': { type: 'boolean' },
    },
    doctor: {
      ...shared,
      fix: { type: 'boolean' },
      deep: { type: 'boolean' },
    },
  };

  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: optionsByCommand[command] ?? shared,
  });
}

function buildEnvelope(ok, command, code, repoRoot, payload) {
  return {
    ok,
    command,
    timestamp: new Date().toISOString(),
    repoRoot: repoRoot ? toPortablePath(repoRoot) : null,
    code,
    ...(ok ? { result: payload } : { error: payload }),
  };
}

async function writeCommandResult(outputOptions, envelope, stderr) {
  if (outputOptions.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (!outputOptions.quiet) {
    if (envelope.ok) {
      log(stderr, `${TOOL_NAME} ${envelope.command}: ok`);
      if (envelope.result?.summary) {
        log(stderr, envelope.result.summary);
      }
    } else {
      log(stderr, `${TOOL_NAME} ${envelope.command}: ${envelope.error.message}`);
    }
  }

  if (outputOptions.output) {
    await writeJson(path.resolve(process.cwd(), outputOptions.output), envelope);
  }
}

async function runCommand(command, parsed) {
  const { values, positionals } = parsed;
  const context = await detectContext(process.cwd());
  const runWithRepoLock = (work) => withLock(context.seedRoot, 'repo', { command }, work);

  if (command === 'create' && values['run-bootstrap'] && values['no-bootstrap']) {
    throw new MwtError({
      code: EXIT_CODES.INVALID_USAGE,
      id: 'conflicting_bootstrap_flags',
      message: 'mwt create cannot use --run-bootstrap and --no-bootstrap together.',
    });
  }

  if (values['dry-run']) {
    switch (command) {
      case 'init':
        return {
          repoRoot: context.worktreeRoot,
          result: {
            ...(await planInitializeRepository(context.worktreeRoot, {
              base: values.base,
              remote: values.remote,
              force: values.force,
            })),
            summary: `Planned initialization for ${toPortablePath(context.worktreeRoot)}.`,
          },
        };
      case 'create': {
        const name = positionals[0] ?? values.name;
        if (!name) {
          throw new MwtError({
            code: EXIT_CODES.INVALID_USAGE,
            id: 'missing_worktree_name',
            message: 'mwt create requires a worktree name.',
          });
        }

        return {
          repoRoot: context.seedRoot,
          result: {
            ...(await planCreateTaskWorktree(context.seedRoot, name, {
              base: values.base,
              bootstrap: values['run-bootstrap'] ? true : (values['no-bootstrap'] ? false : undefined),
              copyProfile: values['copy-profile'],
            })),
            summary: `Planned task worktree creation for ${name}.`,
          },
        };
      }
      case 'sync':
        return {
          repoRoot: context.seedRoot,
          result: {
            ...(await planSyncSeed(context.seedRoot, {
              base: values.base,
            })),
            summary: 'Planned seed synchronization.',
          },
        };
      case 'deliver': {
        let taskRoot = context.worktreeRoot;
        if (positionals[0]) {
          const task = await findTaskByName(context.seedRoot, positionals[0]);
          taskRoot = task.path;
        }

        return {
          repoRoot: context.seedRoot,
          result: {
            ...(await planDeliverTaskWorktree(taskRoot, {
              target: values.target,
              allowDirtyTask: values['allow-dirty-task'],
              resume: values.resume,
            })),
            summary: 'Planned task worktree delivery.',
          },
        };
      }
      case 'prune':
        return {
          repoRoot: context.seedRoot,
          result: {
            ...(await planPruneWorktrees(context.seedRoot, {
              merged: values.merged,
              abandoned: values.abandoned,
              force: values.force,
              withBranches: values['with-branches'],
            })),
            summary: 'Planned worktree pruning.',
          },
        };
      case 'doctor':
        return {
          repoRoot: context.seedRoot,
          result: {
            ...(await planDoctorRepository(context.seedRoot, {
              fix: values.fix,
              deep: values.deep,
            })),
            summary: values.fix ? 'Planned doctor repair actions.' : 'Planned doctor inspection.',
          },
        };
      case 'list':
        return {
          repoRoot: context.worktreeRoot,
          result: {
            items: await listWorktrees(context.worktreeRoot, {
              all: values.all,
              kind: values.kind,
              status: values.status,
            }),
            dryRun: true,
            summary: 'Listed worktrees without mutation.',
          },
        };
      default:
        break;
    }
  }

  switch (command) {
    case 'init': {
      const repoRoot = context.worktreeRoot;
      const result = await initializeRepository(repoRoot, {
        base: values.base,
        remote: values.remote,
        force: values.force,
      });
      return {
        repoRoot,
        result: {
          ...result,
          summary: `Initialized managed-worktree-system in ${toPortablePath(repoRoot)}.`,
        },
      };
    }
    case 'create': {
      const name = positionals[0] ?? values.name;
      if (!name) {
        throw new MwtError({
          code: EXIT_CODES.INVALID_USAGE,
          id: 'missing_worktree_name',
          message: 'mwt create requires a worktree name.',
        });
      }

      const result = await runWithRepoLock(() => createTaskWorktree(context.seedRoot, name, {
        base: values.base,
        bootstrap: values['run-bootstrap'] ? true : (values['no-bootstrap'] ? false : undefined),
        copyProfile: values['copy-profile'],
        yes: values.yes,
      }));
      return {
        repoRoot: context.seedRoot,
        result: {
          ...result,
          summary: `Created task worktree ${result.worktreeName} at ${result.worktreePath}.`,
        },
      };
    }
    case 'list': {
      const result = await listWorktrees(context.worktreeRoot, {
        all: values.all,
        kind: values.kind,
        status: values.status,
      });
      return {
        repoRoot: context.worktreeRoot,
        result: {
          items: result,
          summary: `Listed ${result.length} worktree(s).`,
        },
      };
    }
    case 'sync': {
      const result = await runWithRepoLock(() => syncSeed(context.seedRoot, {
        base: values.base,
      }));
      return {
        repoRoot: context.seedRoot,
        result: {
          ...result,
          summary: `Synchronized seed worktree to ${result.after}.`,
        },
      };
    }
    case 'doctor': {
      const result = values.fix
        ? await runWithRepoLock(() => doctorRepository(context.seedRoot, {
          fix: values.fix,
          deep: values.deep,
        }))
        : await doctorRepository(context.seedRoot, {
          fix: values.fix,
          deep: values.deep,
        });
      return {
        repoRoot: context.seedRoot,
        result: {
          ...result,
          summary: result.issues.length === 0
            ? 'Doctor found no issues.'
            : `Doctor found ${result.issues.length} issue(s).`,
        },
      };
    }
    case 'deliver': {
      let taskRoot = context.worktreeRoot;
      if (positionals[0]) {
        const task = await findTaskByName(context.seedRoot, positionals[0]);
        taskRoot = task.path;
      }

      const result = await runWithRepoLock(() => deliverTaskWorktree(taskRoot, {
        target: values.target,
        allowDirtyTask: values['allow-dirty-task'],
        resume: values.resume,
        yes: values.yes,
      }));
      return {
        repoRoot: context.seedRoot,
        result: {
          ...result,
          summary: `Delivered task worktree ${result.worktreeId} to ${result.targetBranch}.`,
        },
      };
    }
    case 'prune': {
      const result = await runWithRepoLock(() => pruneWorktrees(context.seedRoot, {
        merged: values.merged,
        abandoned: values.abandoned,
        force: values.force,
        withBranches: values['with-branches'],
      }));
      return {
        repoRoot: context.seedRoot,
        result: {
          ...result,
          summary: `Pruned ${result.pruned.length} worktree(s).`,
        },
      };
    }
    default:
      throw new MwtError({
        code: EXIT_CODES.INVALID_USAGE,
        id: 'unsupported_command',
        message: `Unsupported command: ${command}`,
      });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const invocation = resolveInvocation(argv);

  if (invocation.mode === 'help') {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  if (invocation.mode === 'version') {
    process.stdout.write(`${await getVersion()}\n`);
    return;
  }

  const { command, commandArgs, outputOptions } = invocation;
  const parsed = parseCommandOptions(command, commandArgs);
  if (parsed.values.help) {
    process.stdout.write(`${COMMAND_HELP[command] ?? HELP_TEXT}\n`);
    return;
  }

  try {
    const { repoRoot, result } = await runCommand(command, parsed);
    const envelope = buildEnvelope(true, command, EXIT_CODES.SUCCESS, repoRoot, result);
    await writeCommandResult({
      json: parsed.values.json,
      quiet: parsed.values.quiet,
      output: parsed.values.output,
    }, envelope, process.stderr);
    process.exitCode = EXIT_CODES.SUCCESS;
  } catch (error) {
    const mwtError = asMwtError(error);
    const repoRoot = await detectContext(process.cwd())
      .then((context) => context.seedRoot)
      .catch(() => null);
    const envelope = buildEnvelope(false, command, mwtError.code, repoRoot, {
      id: mwtError.id,
      message: mwtError.message,
      details: mwtError.details,
    });
    await writeCommandResult({
      json: parsed.values.json || outputOptions.json,
      quiet: parsed.values.quiet || outputOptions.quiet,
      output: parsed.values.output ?? outputOptions.output,
    }, envelope, process.stderr);
    process.exitCode = mwtError.code;
  }
}

main().catch(async (error) => {
  const mwtError = asMwtError(error);
  const outputOptions = detectOutputOptions(process.argv.slice(2));
  const envelope = buildEnvelope(false, 'fatal', mwtError.code, null, {
    id: mwtError.id,
    message: mwtError.message,
    details: mwtError.details,
  });

  await writeCommandResult(outputOptions, envelope, process.stderr);
  process.exitCode = mwtError.code;
});
