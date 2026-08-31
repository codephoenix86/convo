import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const envModuleUrl = pathToFileURL(resolve('src/config/env.js')).href;

describe('environment configuration', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    const environment = createEnvironment();
    delete environment.DATABASE_URL;

    const result = runEnvironmentImport(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DATABASE_URL: is required');
  });

  it('normalizes valid configuration values', () => {
    const environment = createEnvironment({
      DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test',
      PORT: '4321',
    });

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 4321,
      LOG_LEVEL: 'silent',
      DATABASE_CONNECTION_TIMEOUT_MS: 500,
    });
  });
});

function createEnvironment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3001',
    LOG_LEVEL: 'silent',
    DATABASE_CONNECTION_TIMEOUT_MS: '500',
    ...overrides,
  };
}

function runEnvironmentImport(environment, printEnvironment = false) {
  const source = printEnvironment
    ? `const { env } = await import('${envModuleUrl}'); process.stdout.write(JSON.stringify(env));`
    : `await import('${envModuleUrl}');`;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: tmpdir(),
    env: environment,
    encoding: 'utf8',
  });
}
