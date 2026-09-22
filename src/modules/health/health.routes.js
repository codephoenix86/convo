import { Router } from 'express';

export function createHealthRouter({ database, redisClient, socketAdapter }) {
  const router = Router();

  router.get('/health', livenessHandler);
  router.get('/ready', createReadinessHandler(database, redisClient, socketAdapter));

  return router;
}

function livenessHandler(request, response) {
  void request;

  return response.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
}

function createReadinessHandler(database, redisClient, socketAdapter) {
  return async function readinessHandler(request, response) {
    const dependencies = [database.$queryRaw`SELECT 1`, checkRedis(redisClient)];

    if (socketAdapter) {
      dependencies.push(checkSocketAdapter(socketAdapter));
    }

    const [databaseResult, redisResult, socketAdapterResult] =
      await Promise.allSettled(dependencies);
    const checks = {
      database: databaseResult.status === 'fulfilled' ? 'up' : 'down',
      redis: redisResult.status === 'fulfilled' ? 'up' : 'down',
    };

    if (socketAdapterResult) {
      checks.socketAdapter = socketAdapterResult.status === 'fulfilled' ? 'up' : 'down';
    }

    logFailedCheck(request, 'postgresql', databaseResult);
    logFailedCheck(request, 'redis', redisResult);
    logFailedCheck(request, 'socket.io-redis-adapter', socketAdapterResult);

    if (Object.values(checks).every((status) => status === 'up')) {
      return response
        .set('Cache-Control', 'no-store')
        .status(200)
        .json({ status: 'ready', checks });
    }

    return response
      .set('Cache-Control', 'no-store')
      .status(503)
      .json({ status: 'not_ready', checks });
  };
}

async function checkRedis(redisClient) {
  if (!redisClient.isReady) {
    throw new Error('Redis client is not ready');
  }

  await redisClient.ping();
}

async function checkSocketAdapter(socketAdapter) {
  if (!socketAdapter.isReady()) {
    throw new Error('Socket.IO Redis adapter is not ready');
  }
}

function logFailedCheck(request, dependency, result) {
  if (result?.status === 'rejected') {
    request.log?.error(
      { err: result.reason, dependency, status: 'unavailable' },
      'Dependency readiness check failed',
    );
  }
}
