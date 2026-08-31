import { createServer } from 'node:http';

import { app } from './app.js';
import { db } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const server = createServer(app);

let shutdownPromise;

server.on('error', (error) => {
  logger.fatal({ err: error, event: 'server_error' }, 'HTTP server error');
  void requestShutdown('server_error', 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void requestShutdown(signal, 0);
  });
}

process.once('uncaughtException', (error) => {
  logger.fatal({ err: error, event: 'uncaught_exception' }, 'Uncaught exception');
  void requestShutdown('uncaught_exception', 1);
});

process.once('unhandledRejection', (reason) => {
  logger.fatal(
    {
      err: reason instanceof Error ? reason : new Error(String(reason)),
      event: 'unhandled_rejection',
    },
    'Unhandled promise rejection',
  );
  void requestShutdown('unhandled_rejection', 1);
});

server.listen(env.PORT, env.HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : env.PORT;

  logger.info({ event: 'server_started', host: env.HOST, port }, 'HTTP server started');

  void logDatabaseStatus();
});

function requestShutdown(reason, exitCode) {
  shutdownPromise ??= shutdown(reason, exitCode);

  return shutdownPromise;
}

async function shutdown(reason, exitCode) {
  logger.info({ event: 'shutdown_started', reason }, 'Graceful shutdown started');

  const forceShutdownTimer = setTimeout(() => {
    logger.fatal(
      { event: 'shutdown_timeout', reason, timeoutMs: SHUTDOWN_TIMEOUT_MS },
      'Graceful shutdown timed out',
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  forceShutdownTimer.unref();

  try {
    await closeHttpServer();
    await db.$disconnect();

    process.exitCode = exitCode;
    logger.info({ event: 'shutdown_completed', reason, exitCode }, 'Graceful shutdown completed');
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error, event: 'shutdown_failed', reason }, 'Graceful shutdown failed');
  } finally {
    clearTimeout(forceShutdownTimer);
  }
}

function closeHttpServer() {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function logDatabaseStatus() {
  try {
    await db.$queryRaw`SELECT 1`;
    logger.info({ dependency: 'postgresql', status: 'available' }, 'Dependency check completed');
  } catch (error) {
    logger.error(
      { err: error, dependency: 'postgresql', status: 'unavailable' },
      'Dependency check failed',
    );
  }
}
