import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createApplicationRateLimiters } from '../../src/config/rate-limits.js';

const userId = randomUUID();
const otherUserId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const clientMessageId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const authorization = { authorization: 'Bearer valid-access-token' };

describe('authentication rate limits', () => {
  it.each([
    {
      name: 'registration',
      serviceMethod: 'register',
      expectedStatus: 201,
      execute: (app) =>
        request(app).post('/auth/register').send({
          email: 'limited@example.com',
          username: 'limited_user',
          password: 'Secure-password1!',
        }),
      message: 'Registration attempts are too frequent',
    },
    {
      name: 'login',
      serviceMethod: 'login',
      expectedStatus: 200,
      execute: (app) =>
        request(app)
          .post('/auth/login')
          .send({ identifier: 'limited_user', password: 'Secure-password1!' }),
      message: 'Login attempts are too frequent',
    },
  ])(
    'limits $name by client IP before repeated authentication work',
    async ({ name, serviceMethod, expectedStatus, execute, message }) => {
      const authentication = createAuthentication();
      authentication[serviceMethod].mockResolvedValue({});
      const rateLimiters = createApplicationRateLimiters({
        policies: { [name]: { limit: 2, windowMs: 60_000 } },
      });
      const app = createApp({ authentication, rateLimiters });

      const first = await execute(app).expect(expectedStatus);
      const second = await execute(app).expect(expectedStatus);
      const limited = await execute(app).expect(429);

      expect(first.headers).toMatchObject({
        'ratelimit-limit': '2',
        'ratelimit-remaining': '1',
        'ratelimit-reset': '60',
      });
      expect(second.headers['ratelimit-remaining']).toBe('0');
      expect(limited.headers).toMatchObject({
        'ratelimit-limit': '2',
        'ratelimit-remaining': '0',
        'retry-after': '60',
      });
      expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', message });
      expect(authentication[serviceMethod]).toHaveBeenCalledTimes(2);
    },
  );
});

describe('authenticated endpoint rate limits', () => {
  it.each([
    {
      name: 'userSearch',
      service: 'users',
      serviceMethod: 'search',
      serviceResult: { items: [], nextCursor: null },
      execute: (app) => request(app).get('/users/search').set(authorization).query({ q: 'user' }),
      expectedStatus: 200,
      message: 'User searches are too frequent',
    },
    {
      name: 'messageSend',
      service: 'messages',
      serviceMethod: 'send',
      serviceResult: {
        created: true,
        message: {
          id: messageId,
          conversationId,
          senderId: userId,
          clientMessageId,
          body: 'Limited message',
          createdAt: new Date('2026-09-14T12:00:00.000Z'),
        },
      },
      execute: (app) =>
        request(app)
          .post(`/conversations/${conversationId}/messages`)
          .set(authorization)
          .send({ clientMessageId, body: 'Limited message' }),
      expectedStatus: 201,
      message: 'Message sends are too frequent',
    },
    {
      name: 'uploadInit',
      service: 'attachments',
      serviceMethod: 'initializeUpload',
      serviceResult: {
        storageKey: `conversations/${conversationId}/users/${userId}/${randomUUID()}.png`,
        method: 'PUT',
        url: 'https://storage.example.com/private-upload',
        headers: { 'content-type': 'image/png' },
        expiresAt: new Date('2026-09-14T12:05:00.000Z'),
      },
      execute: (app) =>
        request(app).post('/attachments/upload-init').set(authorization).send({
          conversationId,
          fileName: 'limited.png',
          mimeType: 'image/png',
          size: 1024,
        }),
      expectedStatus: 200,
      message: 'Upload initialization attempts are too frequent',
    },
  ])(
    'limits $name per authenticated user before repeated service work',
    async ({ name, service, serviceMethod, serviceResult, execute, expectedStatus, message }) => {
      const serviceDouble = { [serviceMethod]: vi.fn().mockResolvedValue(serviceResult) };
      const accessTokenVerifier = vi.fn().mockResolvedValue(accessClaims);
      const rateLimiters = createApplicationRateLimiters({
        policies: { [name]: { limit: 1, windowMs: 30_000 } },
      });
      const app = createApp({
        [service]: serviceDouble,
        accessTokenVerifier,
        rateLimiters,
      });

      await execute(app).expect(expectedStatus);
      const limited = await execute(app).expect(429);

      expect(limited.headers).toMatchObject({
        'ratelimit-limit': '1',
        'ratelimit-remaining': '0',
        'ratelimit-reset': '30',
        'retry-after': '30',
      });
      expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', message });
      expect(serviceDouble[serviceMethod]).toHaveBeenCalledOnce();
      expect(accessTokenVerifier).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps authenticated user budgets independent', async () => {
    const users = { search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
    const accessTokenVerifier = vi.fn(async (token) => ({
      ...accessClaims,
      userId: token === 'first-token' ? userId : otherUserId,
    }));
    const rateLimiters = createApplicationRateLimiters({
      policies: { userSearch: { limit: 1, windowMs: 30_000 } },
    });
    const app = createApp({ users, accessTokenVerifier, rateLimiters });

    await request(app)
      .get('/users/search')
      .set('authorization', 'Bearer first-token')
      .query({ q: 'user' })
      .expect(200);
    await request(app)
      .get('/users/search')
      .set('authorization', 'Bearer second-token')
      .query({ q: 'user' })
      .expect(200);

    expect(users.search).toHaveBeenCalledTimes(2);
  });
});

function createAuthentication() {
  return {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  };
}
