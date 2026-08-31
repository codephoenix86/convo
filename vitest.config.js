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
    },
  },
});
