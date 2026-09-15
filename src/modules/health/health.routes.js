import { Router } from 'express';

export function createHealthRouter({ database, redisClient }) {
  const router = Router();

  router.get('/health', livenessHandler);
  router.get('/ready', createReadinessHandler(database, redisClient));

  return router;
}

function livenessHandler(request, response) {
  void request;

  return response.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
}

function createReadinessHandler(database, redisClient) {
  return async function readinessHandler(request, response) {
    const [databaseResult, redisResult] = await Promise.allSettled([
      database.$queryRaw`SELECT 1`,
      checkRedis(redisClient),
    ]);
    const checks = {
      database: databaseResult.status === 'fulfilled' ? 'up' : 'down',
      redis: redisResult.status === 'fulfilled' ? 'up' : 'down',
    };

    logFailedCheck(request, 'postgresql', databaseResult);
    logFailedCheck(request, 'redis', redisResult);

    if (databaseResult.status === 'fulfilled' && redisResult.status === 'fulfilled') {
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

function logFailedCheck(request, dependency, result) {
  if (result.status === 'rejected') {
    request.log?.error(
      { err: result.reason, dependency, status: 'unavailable' },
      'Dependency readiness check failed',
    );
  }
}
