import pino from 'pino';

import { env } from './env.js';

const REDACTED_VALUE = '[REDACTED]';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    pid: process.pid,
    service: 'convo-chat-backend',
    environment: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    censor: REDACTED_VALUE,
    paths: [
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'authorization',
      '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
  },
});
