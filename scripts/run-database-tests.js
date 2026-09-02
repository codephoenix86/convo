import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadLocalEnvironment();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  fail(
    'TEST_DATABASE_URL is required. Point it at a disposable PostgreSQL database whose name ends in "_test".',
  );
}

const parsedTestUrl = parseDatabaseUrl(testDatabaseUrl, 'TEST_DATABASE_URL');
const testDatabaseName = decodeURIComponent(parsedTestUrl.pathname.slice(1));

if (!testDatabaseName.endsWith('_test')) {
  fail(`Refusing to run against database "${testDatabaseName}"; its name must end in "_test".`);
}

if (process.env.DATABASE_URL) {
  const developmentUrl = parseDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');

  if (sameDatabase(developmentUrl, parsedTestUrl)) {
    fail('TEST_DATABASE_URL must not point at the development database.');
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childEnvironment = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl,
};

runNodeCommand('apply test database migrations', [
  path.join(projectRoot, 'node_modules/prisma/build/index.js'),
  'migrate',
  'deploy',
]);
runNodeCommand('run database integration tests', [
  path.join(projectRoot, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  'vitest.database.config.js',
]);

function loadLocalEnvironment() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function parseDatabaseUrl(value, name) {
  try {
    const url = new URL(value);

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname === '/'
    ) {
      throw new Error('invalid PostgreSQL URL');
    }

    return url;
  } catch {
    fail(`${name} must be a valid PostgreSQL database URL.`);
  }
}

function sameDatabase(left, right) {
  return (
    left.hostname === right.hostname &&
    effectivePort(left) === effectivePort(right) &&
    decodeURIComponent(left.pathname) === decodeURIComponent(right.pathname)
  );
}

function effectivePort(url) {
  return url.port || '5432';
}

function runNodeCommand(description, arguments_) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`Could not ${description}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(`Database test safety check failed: ${message}`);
  process.exit(1);
}
