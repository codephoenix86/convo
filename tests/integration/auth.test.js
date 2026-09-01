import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

const userId = randomUUID();
const authenticationResult = {
  user: {
    id: userId,
    email: 'person@example.com',
    username: 'person_name',
    avatarUrl: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  },
  tokens: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresIn: 900,
  },
};

function createAuthentication() {
  return {
    register: vi.fn(),
    login: vi.fn(),
  };
}

describe('POST /auth/register', () => {
  it('normalizes input and returns a new authenticated session', async () => {
    const authentication = createAuthentication();
    authentication.register.mockResolvedValue(authenticationResult);

    const response = await request(createApp({ authentication }))
      .post('/auth/register')
      .set('user-agent', 'integration-test-client')
      .send({
        email: '  PERSON@Example.COM ',
        username: ' Person_Name ',
        password: 'Secure-password1!',
      })
      .expect(201);

    expect(authentication.register).toHaveBeenCalledWith(
      {
        email: 'person@example.com',
        username: 'person_name',
        password: 'Secure-password1!',
      },
      expect.objectContaining({ userAgent: 'integration-test-client' }),
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      data: {
        ...authenticationResult,
        user: {
          ...authenticationResult.user,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    });
    expect(response.text).not.toContain('Secure-password1!');
  });

  it('rejects weak credentials before calling the service', async () => {
    const authentication = createAuthentication();

    const response = await request(createApp({ authentication }))
      .post('/auth/register')
      .send({ email: 'invalid', username: 'x', password: 'weak' })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request body validation failed',
    });
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email' }),
        expect.objectContaining({ field: 'username' }),
        expect.objectContaining({ field: 'password' }),
      ]),
    );
    expect(authentication.register).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login', () => {
  it('normalizes the identifier and returns an authenticated session', async () => {
    const authentication = createAuthentication();
    authentication.login.mockResolvedValue(authenticationResult);

    const response = await request(createApp({ authentication }))
      .post('/auth/login')
      .send({ identifier: ' PERSON@Example.COM ', password: 'password' })
      .expect(200);

    expect(authentication.login).toHaveBeenCalledWith(
      { identifier: 'person@example.com', password: 'password' },
      expect.objectContaining({ ipAddress: expect.any(String) }),
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data.tokens).toEqual(authenticationResult.tokens);
  });

  it('returns a generic unauthorized response for invalid credentials', async () => {
    const authentication = createAuthentication();
    authentication.login.mockRejectedValue(
      new UnauthorizedError('Invalid email, username, or password'),
    );

    const response = await request(createApp({ authentication }))
      .post('/auth/login')
      .send({ identifier: 'missing@example.com', password: 'wrong-password' })
      .expect(401);

    expect(response.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid email, username, or password',
    });
  });
});
