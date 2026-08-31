import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { db } from '../../src/config/db.js';

afterAll(async () => {
  await db.$disconnect();
});

describe('system endpoints', () => {
  it('reports liveness without querying the database', async () => {
    const database = { $queryRaw: vi.fn() };

    const response = await request(createApp({ database }))
      .get('/health')
      .set('x-request-id', 'test-health-request')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBe('test-health-request');
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports readiness when PostgreSQL responds', async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ value: 1 }]) };

    const response = await request(createApp({ database })).get('/ready').expect(200);

    expect(response.body).toEqual({ status: 'ready', checks: { database: 'up' } });
    expect(database.$queryRaw).toHaveBeenCalledOnce();
  });

  it('reports unavailable readiness without leaking the database error', async () => {
    const database = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('sensitive database failure')),
    };

    const response = await request(createApp({ database })).get('/ready').expect(503);

    expect(response.body).toEqual({ status: 'not_ready', checks: { database: 'down' } });
    expect(response.text).not.toContain('sensitive database failure');
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
