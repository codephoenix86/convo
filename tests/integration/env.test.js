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

  it('fails fast when ACCESS_TOKEN_SECRET is missing', () => {
    const environment = createEnvironment();
    delete environment.ACCESS_TOKEN_SECRET;

    const result = runEnvironmentImport(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ACCESS_TOKEN_SECRET: is required');
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
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
      JWT_ISSUER: 'convo-api-test',
      JWT_AUDIENCE: 'convo-client-test',
      CLIENT_ORIGINS: ['http://localhost:5173'],
      ATTACHMENT_STORAGE_DRIVER: 's3',
      LOCAL_STORAGE_DIRECTORY: './storage',
      LOCAL_STORAGE_URL_TTL_SECONDS: 300,
      OBJECT_STORAGE_REGION: 'us-east-1',
      OBJECT_STORAGE_BUCKET: 'convo-test-attachments',
      OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      OBJECT_STORAGE_PRESIGN_TTL_SECONDS: 300,
    });
  });

  it('normalizes a comma-separated client origin allowlist', () => {
    const environment = createEnvironment({
      DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test',
      CLIENT_ORIGINS: 'https://chat.example.com, http://localhost:5173/',
    });

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).CLIENT_ORIGINS).toEqual([
      'https://chat.example.com',
      'http://localhost:5173',
    ]);
  });

  it('provides a local development client origin by default', () => {
    const environment = createEnvironment({
      DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test',
    });
    delete environment.CLIENT_ORIGINS;

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).CLIENT_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('rejects invalid client origins', () => {
    const environment = createEnvironment({
      DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test',
      CLIENT_ORIGINS: 'https://chat.example.com/path',
    });

    const result = runEnvironmentImport(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLIENT_ORIGINS: contains an invalid origin');
  });

  it('fails fast when object-storage credentials are missing', () => {
    const environment = createEnvironment();
    delete environment.OBJECT_STORAGE_ACCESS_KEY_ID;

    const result = runEnvironmentImport(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('OBJECT_STORAGE_ACCESS_KEY_ID: is required');
  });

  it('does not require S3 configuration when local attachment storage is selected', () => {
    const environment = createEnvironment({
      ATTACHMENT_STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIRECTORY: '/tmp/convo-test-attachments',
    });
    delete environment.OBJECT_STORAGE_REGION;
    delete environment.OBJECT_STORAGE_BUCKET;
    delete environment.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete environment.OBJECT_STORAGE_SECRET_ACCESS_KEY;

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ATTACHMENT_STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIRECTORY: '/tmp/convo-test-attachments',
      LOCAL_STORAGE_SIGNING_SECRET: environment.ACCESS_TOKEN_SECRET,
    });
  });

  it('requires only Cloudinary credentials when Cloudinary storage is selected', () => {
    const environment = createEnvironment({
      ATTACHMENT_STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'convo-cloud',
      CLOUDINARY_API_KEY: 'cloudinary-key',
      CLOUDINARY_API_SECRET: 'cloudinary-secret',
    });
    delete environment.OBJECT_STORAGE_REGION;
    delete environment.OBJECT_STORAGE_BUCKET;
    delete environment.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete environment.OBJECT_STORAGE_SECRET_ACCESS_KEY;

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ATTACHMENT_STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'convo-cloud',
      CLOUDINARY_API_KEY: 'cloudinary-key',
      CLOUDINARY_API_SECRET: 'cloudinary-secret',
      CLOUDINARY_DOWNLOAD_URL_TTL_SECONDS: 300,
    });
  });

  it('fails fast when selected Cloudinary credentials are missing', () => {
    const environment = createEnvironment({
      ATTACHMENT_STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'convo-cloud',
      CLOUDINARY_API_KEY: 'cloudinary-key',
    });

    const result = runEnvironmentImport(environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLOUDINARY_API_SECRET: is required');
  });

  it('normalizes an optional S3-compatible endpoint and path-style setting', () => {
    const environment = createEnvironment({
      OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
    });

    const result = runEnvironmentImport(environment, true);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_FORCE_PATH_STYLE: false,
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
    ACCESS_TOKEN_SECRET: 'integration-test-access-token-secret-value',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_DAYS: '30',
    JWT_ISSUER: 'convo-api-test',
    JWT_AUDIENCE: 'convo-client-test',
    CLIENT_ORIGINS: 'http://localhost:5173',
    OBJECT_STORAGE_REGION: 'us-east-1',
    OBJECT_STORAGE_BUCKET: 'convo-test-attachments',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-object-storage-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-object-storage-secret-key',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    OBJECT_STORAGE_PRESIGN_TTL_SECONDS: '300',
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
