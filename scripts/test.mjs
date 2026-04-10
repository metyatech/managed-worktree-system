import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const requiredFiles = [
  'agent-ruleset.json',
  'README.md',
  'docs/managed-worktree-system-design.md',
  'LICENSE',
];

for (const file of requiredFiles) {
  const fullPath = resolve(root, file);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const ruleset = JSON.parse(readFileSync(resolve(root, 'agent-ruleset.json'), 'utf8'));
if (ruleset.source !== 'github:metyatech/agent-rules') {
  throw new Error('agent-ruleset.json must point at github:metyatech/agent-rules');
}

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
if (!readme.includes('docs/managed-worktree-system-design.md')) {
  throw new Error('README.md must link to the design document');
}

console.log('Tests OK.');
