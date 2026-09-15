import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { db } from '../../src/config/db.js';

afterAll(async () => {
  await db.$disconnect();
});

describe('system endpoints', () => {
  it('reports liveness without querying dependencies', async () => {
    const database = { $queryRaw: vi.fn() };
    const redisClient = { ping: vi.fn() };

    const response = await request(createApp({ database, redisClient }))
      .get('/health')
      .set('x-request-id', 'test-health-request')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe('test-health-request');
    expect(database.$queryRaw).not.toHaveBeenCalled();
    expect(redisClient.ping).not.toHaveBeenCalled();
  });

  it('reports readiness when PostgreSQL and Redis respond', async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ value: 1 }]) };
    const redisClient = createReadyRedisClient();

    const response = await request(createApp({ database, redisClient })).get('/ready').expect(200);

    expect(response.body).toEqual({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(redisClient.ping).toHaveBeenCalledOnce();
  });

  it('reports unavailable readiness without leaking the database error', async () => {
    const database = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('sensitive database failure')),
    };

    const response = await request(createApp({ database, redisClient: createReadyRedisClient() }))
      .get('/ready')
      .expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { database: 'down', redis: 'up' },
    });
    expect(response.text).not.toContain('sensitive database failure');
  });

  it('reports unavailable readiness when Redis is disconnected without issuing a command', async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ value: 1 }]) };
    const redisClient = { isReady: false, ping: vi.fn() };

    const response = await request(createApp({ database, redisClient })).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { database: 'up', redis: 'down' },
    });
    expect(redisClient.ping).not.toHaveBeenCalled();
  });

  it('does not leak Redis readiness errors', async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ value: 1 }]) };
    const redisClient = createReadyRedisClient();
    redisClient.ping.mockRejectedValue(new Error('sensitive Redis failure'));

    const response = await request(createApp({ database, redisClient })).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { database: 'up', redis: 'down' },
    });
    expect(response.text).not.toContain('sensitive Redis failure');
  });
});

function createReadyRedisClient() {
  return { isReady: true, ping: vi.fn().mockResolvedValue('PONG') };
}

describe('HTTP security policy', () => {
  const database = { $queryRaw: vi.fn() };
  const allowedOrigin = 'https://chat.example.com';

  it('adds Helmet security headers', async () => {
    const response = await request(createApp({ database })).get('/health').expect(200);

    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('allows configured browser origins and exposes request tracing and rate-limit headers', async () => {
    const response = await request(createApp({ database, allowedOrigins: [allowedOrigin] }))
      .get('/health')
      .set('origin', allowedOrigin)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-expose-headers']).toBe(
      'X-Request-Id,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,Retry-After',
    );
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toContain('Origin');
  });

  it('handles an allowed preflight with explicit methods and headers', async () => {
    const response = await request(createApp({ database, allowedOrigins: [allowedOrigin] }))
      .options('/users/me')
      .set('origin', allowedOrigin)
      .set('access-control-request-method', 'PATCH')
      .set('access-control-request-headers', 'authorization,content-type,x-request-id')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    expect(response.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type,X-Request-Id',
    );
    expect(response.headers['access-control-max-age']).toBe('600');
  });

  it('does not grant CORS access to an unconfigured origin', async () => {
    const response = await request(createApp({ database, allowedOrigins: [allowedOrigin] }))
      .get('/health')
      .set('origin', 'https://attacker.example.com')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('HTTP error contract', () => {
  const database = { $queryRaw: vi.fn() };

  it('returns a correlated JSON response for unknown routes', async () => {
    const response = await request(createApp({ database })).get('/missing').expect(404);

    expect(response.body.error).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found',
      requestId: response.headers['x-request-id'],
    });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects malformed JSON consistently', async () => {
    const response = await request(createApp({ database }))
      .post('/missing')
      .set('content-type', 'application/json')
      .send('{')
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request body contains malformed JSON',
    });
  });

  it('does not expose unexpected error details', async () => {
    const app = createApp({
      database,
      registerRoutes(application) {
        application.get('/failure', async () => {
          throw new Error('sensitive internal detail');
        });
      },
    });

    const response = await request(app).get('/failure').expect(500);

    expect(response.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: response.headers['x-request-id'],
    });
    expect(response.text).not.toContain('sensitive internal detail');
  });

  it('replaces invalid incoming request IDs', async () => {
    const response = await request(createApp({ database }))
      .get('/missing')
      .set('x-request-id', 'invalid request id')
      .expect(404);

    expect(response.headers['x-request-id']).not.toBe('invalid request id');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
