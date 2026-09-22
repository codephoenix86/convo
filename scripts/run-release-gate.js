import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const imageTag = 'convo-chat-backend:release-check';
const runtimeVerification = [
  "import argon2 from 'argon2';",
  "import { existsSync } from 'node:fs';",
  'const migrationRuntimeExists =',
  "  existsSync('/app/node_modules/prisma/build/index.js') &&",
  "  existsSync('/app/prisma/schema.prisma') &&",
  "  existsSync('/app/prisma.config.js');",
  "if (process.getuid() === 0 || existsSync('/app/node_modules/vitest') || !migrationRuntimeExists) {",
  '  process.exit(1);',
  '}',
  "console.log('Production runtime contents verified');",
].join('\n');

const steps = [
  command('check formatting', npmCommand, ['run', 'format:check']),
  command('lint JavaScript', npmCommand, ['run', 'lint']),
  command('validate the Prisma schema', npmCommand, ['run', 'db:validate']),
  command('run unit, integration, and realtime tests', npmCommand, ['test']),
  command('run migrated PostgreSQL tests', npmCommand, ['run', 'test:database']),
  command('prove two-instance scaling', npmCommand, ['run', 'test:scaling']),
  command('validate the Docker Compose model', 'docker', ['compose', 'config', '--quiet']),
  command('check the Dockerfile', 'docker', ['buildx', 'build', '--check', '.']),
  command('build the production image', 'docker', [
    'buildx',
    'build',
    '--target',
    'runtime',
    '--load',
    '--tag',
    imageTag,
    '.',
  ]),
  command('verify the production runtime contents', 'docker', [
    'run',
    '--rm',
    '--entrypoint',
    'node',
    imageTag,
    '--input-type=module',
    '--eval',
    runtimeVerification,
  ]),
  command('validate the Prisma schema from the production image', 'docker', [
    'run',
    '--rm',
    '--env-file',
    '.env.example',
    imageTag,
    'npm',
    'run',
    'db:validate',
  ]),
];

for (const [index, step] of steps.entries()) {
  console.log(`\n${index + 1}/${steps.length} ${step.description}`);

  const result = spawnSync(step.executable, step.arguments_, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`Could not ${step.description}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`${step.description} failed with exit code ${result.status ?? 1}.`, result.status);
  }
}

console.log('\nLocal release gate completed successfully.');
console.log(
  'Verify the public HTTPS/WSS deployment separately before declaring a production release.',
);

function command(description, executable, arguments_) {
  return { description, executable, arguments_ };
}

function fail(message, exitCode = 1) {
  console.error(`\nRelease gate failed: ${message}`);
  process.exit(exitCode ?? 1);
}
