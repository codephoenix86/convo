import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const userId = randomUUID();
const conversationId = randomUUID();
const clientMessageId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const message = {
  id: randomUUID(),
  conversationId,
  senderId: userId,
  clientMessageId,
  body: 'Hello there',
  type: 'TEXT',
  replyToId: null,
  createdAt: new Date('2026-09-02T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T10:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  sender: { id: userId, username: 'sender', avatarUrl: null },
};

function createMessages() {
  return {
    create: vi.fn(),
    listHistory: vi.fn(),
  };
}

function createAuthenticatedApp(messages) {
  return createApp({
    messages,
    accessTokenVerifier: vi.fn().mockResolvedValue(accessClaims),
  });
}

describe('POST /conversations/:id/messages', () => {
  it.each([
    [true, 201],
    [false, 200],
  ])('returns the canonical message when created is %s', async (created, statusCode) => {
    const messages = createMessages();
    messages.create.mockResolvedValue({ message, created });

    const response = await request(createAuthenticatedApp(messages))
      .post(`/conversations/${conversationId}/messages`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ clientMessageId, body: '  Hello there  ' })
      .expect(statusCode);

    expect(messages.create).toHaveBeenCalledWith(userId, conversationId, {
      clientMessageId,
      body: 'Hello there',
    });
    expect(response.body.data.message).toMatchObject({
      id: message.id,
      clientMessageId,
      body: 'Hello there',
    });
  });

  it('rejects invalid IDs, blank/oversized bodies, and unrelated fields', async () => {
    const messages = createMessages();
    const app = createAuthenticatedApp(messages);
    const authorization = { authorization: 'Bearer valid-access-token' };

    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(authorization)
      .send({ clientMessageId: 'invalid', body: 'Hello' })
      .expect(400);
    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(authorization)
      .send({ clientMessageId, body: '   ' })
      .expect(400);
    await request(app)
      .post(`/conversations/${conversationId}/messages`)
      .set(authorization)
      .send({ clientMessageId, body: 'Hello', senderId: userId })
      .expect(400);

    expect(messages.create).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated message creation', async () => {
    const messages = createMessages();

    await request(createApp({ messages }))
      .post(`/conversations/${conversationId}/messages`)
      .send({ clientMessageId, body: 'Hello' })
      .expect(401);

    expect(messages.create).not.toHaveBeenCalled();
  });
});

describe('GET /conversations/:id/messages', () => {
  it('returns stable, bounded message history', async () => {
    const messages = createMessages();
    messages.listHistory.mockResolvedValue({ items: [message], nextCursor: 'next-cursor' });

    const response = await request(createAuthenticatedApp(messages))
      .get(`/conversations/${conversationId}/messages`)
      .set('authorization', 'Bearer valid-access-token')
      .query({ cursor: 'current-cursor', limit: 25 })
      .expect(200);

    expect(messages.listHistory).toHaveBeenCalledWith(userId, conversationId, {
      cursor: 'current-cursor',
      limit: 25,
    });
    expect(response.body.data).toMatchObject({
      items: [{ id: message.id, body: 'Hello there' }],
      nextCursor: 'next-cursor',
    });
  });

  it('rejects invalid conversation IDs and unbounded pages', async () => {
    const messages = createMessages();
    const app = createAuthenticatedApp(messages);
    const authorization = { authorization: 'Bearer valid-access-token' };

    await request(app).get('/conversations/not-a-uuid/messages').set(authorization).expect(400);
    await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set(authorization)
      .query({ limit: 100 })
      .expect(400);

    expect(messages.listHistory).not.toHaveBeenCalled();
  });
});
