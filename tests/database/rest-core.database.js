import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { db } from '../../src/config/db.js';
import { hashPassword } from '../../src/modules/auth/password.js';

const users = Object.freeze({
  alice: {
    id: randomUUID(),
    email: 'alice.database@example.com',
    username: 'alice_database',
  },
  bob: {
    id: randomUUID(),
    email: 'bob.database@example.com',
    username: 'bob_database',
  },
  charlie: {
    id: randomUUID(),
    email: 'charlie.database@example.com',
    username: 'charlie_database',
  },
});
const accessTokens = new Map([
  ['alice-access', users.alice.id],
  ['bob-access', users.bob.id],
  ['charlie-access', users.charlie.id],
]);

let fixturePasswordHash;

beforeAll(async () => {
  fixturePasswordHash = await hashPassword('Fixture-password1!');
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await db.$disconnect();
});

describe('database-backed authentication flow', () => {
  it('persists unique users, rotates refresh tokens, and revokes every active session', async () => {
    const app = createApp();
    const credentials = {
      email: 'real.user@example.com',
      username: 'real_user',
      password: 'Secure-password1!',
    };

    const registration = await request(app).post('/auth/register').send(credentials).expect(201);

    await request(app)
      .post('/auth/register')
      .send({ ...credentials, username: 'another_name' })
      .expect(409);
    expect(await db.user.count()).toBe(1);

    const login = await request(app)
      .post('/auth/login')
      .send({ identifier: 'REAL_USER', password: credentials.password })
      .expect(200);
    const loginRefreshToken = login.body.data.tokens.refreshToken;

    const refresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: loginRefreshToken })
      .expect(200);

    await request(app).post('/auth/refresh').send({ refreshToken: loginRefreshToken }).expect(401);

    await request(app)
      .post('/auth/logout-all')
      .set('authorization', `Bearer ${refresh.body.data.tokens.accessToken}`)
      .expect(204);

    expect(registration.body.data.user.email).toBe(credentials.email);
    expect(await db.refreshSession.count({ where: { revokedAt: null } })).toBe(0);
  });
});

describe('database-backed conversation rules', () => {
  it('reuses direct conversations and commits group membership only when all users exist', async () => {
    await createFixtureUsers();
    const app = createFixtureApp();

    const firstDirect = await authenticatedRequest(app, 'alice-access')
      .post('/conversations/direct')
      .send({ userId: users.bob.id })
      .expect(200);
    const retriedDirect = await authenticatedRequest(app, 'bob-access')
      .post('/conversations/direct')
      .send({ userId: users.alice.id })
      .expect(200);

    expect(retriedDirect.body.data.conversation.id).toBe(firstDirect.body.data.conversation.id);
    expect(await db.conversation.count({ where: { type: 'DIRECT' } })).toBe(1);

    await authenticatedRequest(app, 'alice-access')
      .post('/conversations/group')
      .send({ name: 'Should roll back', memberIds: [randomUUID()] })
      .expect(404);
    expect(await db.conversation.count({ where: { type: 'GROUP' } })).toBe(0);

    const groupResponse = await authenticatedRequest(app, 'alice-access')
      .post('/conversations/group')
      .send({ name: 'Database Team', memberIds: [users.bob.id] })
      .expect(201);
    const groupId = groupResponse.body.data.conversation.id;

    await authenticatedRequest(app, 'bob-access')
      .post(`/conversations/${groupId}/members`)
      .send({ userId: users.charlie.id })
      .expect(403);
    await authenticatedRequest(app, 'alice-access')
      .post(`/conversations/${groupId}/members`)
      .send({ userId: users.charlie.id, role: 'ADMIN' })
      .expect(201);
    await authenticatedRequest(app, 'charlie-access')
      .patch(`/conversations/${groupId}`)
      .send({ name: 'Renamed Database Team' })
      .expect(200);
    await authenticatedRequest(app, 'charlie-access')
      .patch(`/conversations/${groupId}/members/${users.bob.id}`)
      .send({ role: 'ADMIN' })
      .expect(403);

    const storedGroup = await db.conversation.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    expect(storedGroup).toMatchObject({ name: 'Renamed Database Team' });
    expect(storedGroup.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: users.alice.id, role: 'OWNER' }),
        expect.objectContaining({ userId: users.bob.id, role: 'MEMBER' }),
        expect.objectContaining({ userId: users.charlie.id, role: 'ADMIN' }),
      ]),
    );
  });
});

describe('database-backed message flow', () => {
  it('enforces membership and idempotency while paginating without duplicates or gaps', async () => {
    await createFixtureUsers();
    const app = createFixtureApp();
    const direct = await authenticatedRequest(app, 'alice-access')
      .post('/conversations/direct')
      .send({ userId: users.bob.id })
      .expect(200);
    const conversationId = direct.body.data.conversation.id;
    const firstClientMessageId = randomUUID();

    const firstSend = await sendMessage(app, 'alice-access', conversationId, {
      clientMessageId: firstClientMessageId,
      body: 'Canonical body',
    }).expect(201);
    const retry = await sendMessage(app, 'alice-access', conversationId, {
      clientMessageId: firstClientMessageId,
      body: 'A retry cannot replace the canonical body',
    }).expect(200);

    expect(retry.body.data.message).toMatchObject({
      id: firstSend.body.data.message.id,
      body: 'Canonical body',
    });
    expect(await db.message.count({ where: { conversationId } })).toBe(1);

    await sendMessage(app, 'bob-access', conversationId, {
      clientMessageId: randomUUID(),
      body: 'Second message',
      replyToId: firstSend.body.data.message.id,
    }).expect(201);
    await sendMessage(app, 'alice-access', conversationId, {
      clientMessageId: randomUUID(),
      body: 'Third message',
    }).expect(201);

    await sendMessage(app, 'charlie-access', conversationId, {
      clientMessageId: randomUUID(),
      body: 'Unauthorized message',
    }).expect(404);
    await authenticatedRequest(app, 'charlie-access')
      .get(`/conversations/${conversationId}/messages`)
      .expect(404);

    const firstPage = await authenticatedRequest(app, 'alice-access')
      .get(`/conversations/${conversationId}/messages`)
      .query({ limit: 2 })
      .expect(200);
    const secondPage = await authenticatedRequest(app, 'alice-access')
      .get(`/conversations/${conversationId}/messages`)
      .query({ cursor: firstPage.body.data.nextCursor, limit: 2 })
      .expect(200);
    const history = [...firstPage.body.data.items, ...secondPage.body.data.items];

    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));
    expect(secondPage.body.data.nextCursor).toBeNull();
    expect(history).toHaveLength(3);
    expect(new Set(history.map((message) => message.id)).size).toBe(3);
    expect(await db.message.count({ where: { conversationId } })).toBe(3);
  });
});

function createFixtureApp() {
  return createApp({
    accessTokenVerifier: async (token) => {
      const userId = accessTokens.get(token);

      if (!userId) {
        throw new Error('Invalid fixture access token');
      }

      return { userId, sessionId: randomUUID(), tokenId: randomUUID() };
    },
  });
}

function authenticatedRequest(app, token) {
  const agent = request(app);
  const authorization = `Bearer ${token}`;

  return {
    delete: (path) => agent.delete(path).set('authorization', authorization),
    get: (path) => agent.get(path).set('authorization', authorization),
    patch: (path) => agent.patch(path).set('authorization', authorization),
    post: (path) => agent.post(path).set('authorization', authorization),
  };
}

function sendMessage(app, token, conversationId, body) {
  return authenticatedRequest(app, token)
    .post(`/conversations/${conversationId}/messages`)
    .send(body);
}

async function createFixtureUsers() {
  await db.user.createMany({
    data: Object.values(users).map((user) => ({ ...user, passwordHash: fixturePasswordHash })),
  });
}

async function resetDatabase() {
  await db.conversationMember.updateMany({
    data: { lastReadMessageId: null, lastReadAt: null },
  });
  await db.message.deleteMany();
  await db.refreshSession.deleteMany();
  await db.conversation.deleteMany();
  await db.user.deleteMany();
}
