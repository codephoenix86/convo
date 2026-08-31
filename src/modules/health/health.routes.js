import { Router } from 'express';

export function createHealthRouter({ database }) {
  const router = Router();

  router.get('/health', livenessHandler);
  router.get('/ready', createReadinessHandler(database));

  return router;
}

function livenessHandler(request, response) {
  void request;

  return response.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
}

function createReadinessHandler(database) {
  return async function readinessHandler(request, response) {
    void request;

    try {
      await database.$queryRaw`SELECT 1`;

      return response
        .set('Cache-Control', 'no-store')
        .status(200)
        .json({ status: 'ready', checks: { database: 'up' } });
    } catch (error) {
      request.log?.error({ err: error }, 'Database readiness check failed');

      return response
        .set('Cache-Control', 'no-store')
        .status(503)
        .json({ status: 'not_ready', checks: { database: 'down' } });
    }
  };
}
