import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3001',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://convo:convo@localhost:5432/convo_test?schema=public',
      DATABASE_CONNECTION_TIMEOUT_MS: '500',
      ACCESS_TOKEN_SECRET: 'unit-test-access-token-secret-32-characters',
      ACCESS_TOKEN_TTL_SECONDS: '900',
      REFRESH_TOKEN_TTL_DAYS: '30',
      JWT_ISSUER: 'convo-api-test',
      JWT_AUDIENCE: 'convo-client-test',
    },
  },
});
