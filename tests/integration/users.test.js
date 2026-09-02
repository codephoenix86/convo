import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const userId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const profile = {
  id: userId,
  username: 'person_name',
  email: 'person@example.com',
  avatarUrl: null,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
};

function createUsers() {
  return {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    search: vi.fn(),
  };
}

function createAuthenticatedApp(users) {
  return createApp({
    users,
    accessTokenVerifier: vi.fn().mockResolvedValue(accessClaims),
  });
}

describe('GET /users/me', () => {
  it('returns only the authenticated user profile', async () => {
    const users = createUsers();
    users.getProfile.mockResolvedValue(profile);

    const response = await request(createAuthenticatedApp(users))
      .get('/users/me')
      .set('authorization', 'Bearer valid-access-token')
      .expect(200);

    expect(users.getProfile).toHaveBeenCalledWith(userId);
    expect(response.body.data.user).toEqual({
      ...profile,
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
    });
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects unauthenticated access', async () => {
    const users = createUsers();

    const response = await request(createApp({ users })).get('/users/me').expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(users.getProfile).not.toHaveBeenCalled();
  });
});

describe('PATCH /users/me', () => {
  it('normalizes and updates only allowed profile fields', async () => {
    const users = createUsers();
    users.updateProfile.mockResolvedValue({
      ...profile,
      username: 'new_name',
      avatarUrl: 'https://example.com/avatar.png',
    });

    const response = await request(createAuthenticatedApp(users))
      .patch('/users/me')
      .set('authorization', 'Bearer valid-access-token')
      .send({ username: ' New_Name ', avatarUrl: ' https://example.com/avatar.png ' })
      .expect(200);

    expect(users.updateProfile).toHaveBeenCalledWith(userId, {
      username: 'new_name',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(response.body.data.user.username).toBe('new_name');
  });

  it('rejects disallowed fields and empty updates', async () => {
    const users = createUsers();
    const app = createAuthenticatedApp(users);

    await request(app)
      .patch('/users/me')
      .set('authorization', 'Bearer valid-access-token')
      .send({ email: 'replacement@example.com' })
      .expect(400);

    await request(app)
      .patch('/users/me')
      .set('authorization', 'Bearer valid-access-token')
      .send({})
      .expect(400);

    expect(users.updateProfile).not.toHaveBeenCalled();
  });
});

describe('GET /users/search', () => {
  it('normalizes the query and applies a bounded default page size', async () => {
    const users = createUsers();
    users.search.mockResolvedValue({
      items: [{ id: randomUUID(), username: 'person_two', avatarUrl: null }],
      nextCursor: 'next-cursor',
    });

    const response = await request(createAuthenticatedApp(users))
      .get('/users/search')
      .set('authorization', 'Bearer valid-access-token')
      .query({ q: ' PER ' })
      .expect(200);

    expect(users.search).toHaveBeenCalledWith({
      requestingUserId: userId,
      query: 'per',
      cursor: undefined,
      limit: 20,
    });
    expect(response.body.data).toEqual({
      items: [expect.objectContaining({ username: 'person_two' })],
      nextCursor: 'next-cursor',
    });
  });

  it('rejects short queries and unbounded page sizes before searching', async () => {
    const users = createUsers();
    const app = createAuthenticatedApp(users);

    await request(app)
      .get('/users/search')
      .set('authorization', 'Bearer valid-access-token')
      .query({ q: 'p' })
      .expect(400);

    await request(app)
      .get('/users/search')
      .set('authorization', 'Bearer valid-access-token')
      .query({ q: 'person', limit: 500 })
      .expect(400);

    expect(users.search).not.toHaveBeenCalled();
  });
});
