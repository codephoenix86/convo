import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/database/**/*.database.js'],
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3001',
      LOG_LEVEL: 'silent',
      DATABASE_CONNECTION_TIMEOUT_MS: '5000',
      ACCESS_TOKEN_SECRET: 'database-test-access-token-secret-32-characters',
      ACCESS_TOKEN_TTL_SECONDS: '900',
      REFRESH_TOKEN_TTL_DAYS: '30',
      JWT_ISSUER: 'convo-api-database-test',
      JWT_AUDIENCE: 'convo-client-database-test',
    },
  },
});
