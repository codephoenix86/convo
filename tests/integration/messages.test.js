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
    send: vi.fn(),
    listHistory: vi.fn(),
    markRead: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
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
    messages.send.mockResolvedValue({ message, created });

    const response = await request(createAuthenticatedApp(messages))
      .post(`/conversations/${conversationId}/messages`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ clientMessageId, body: '  Hello there  ' })
      .expect(statusCode);

    expect(messages.send).toHaveBeenCalledWith(userId, {
      conversationId,
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

    expect(messages.send).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated message creation', async () => {
    const messages = createMessages();

    await request(createApp({ messages }))
      .post(`/conversations/${conversationId}/messages`)
      .send({ clientMessageId, body: 'Hello' })
      .expect(401);

    expect(messages.send).not.toHaveBeenCalled();
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

describe('PUT /conversations/:id/read', () => {
  it('returns the caller read state after advancing through a message', async () => {
    const messages = createMessages();
    const readState = {
      conversationId,
      userId,
      lastReadMessageId: message.id,
      lastReadAt: message.createdAt,
    };
    messages.markRead.mockResolvedValue(readState);

    const response = await request(createAuthenticatedApp(messages))
      .put(`/conversations/${conversationId}/read`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ messageId: message.id })
      .expect(200);

    expect(messages.markRead).toHaveBeenCalledWith(userId, {
      conversationId,
      messageId: message.id,
    });
    expect(response.body.data.readState).toMatchObject({
      conversationId,
      userId,
      lastReadMessageId: message.id,
    });
  });

  it('rejects malformed or unauthenticated read updates before service logic', async () => {
    const messages = createMessages();
    const authenticatedApp = createAuthenticatedApp(messages);

    await request(authenticatedApp)
      .put(`/conversations/${conversationId}/read`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ messageId: 'not-a-uuid' })
      .expect(400);
    await request(createApp({ messages }))
      .put(`/conversations/${conversationId}/read`)
      .send({ messageId: message.id })
      .expect(401);

    expect(messages.markRead).not.toHaveBeenCalled();
  });
});

describe('message mutation endpoints', () => {
  it('edits a message with a normalized body', async () => {
    const messages = createMessages();
    const editedMessage = { ...message, body: 'Edited body', editedAt: new Date() };
    messages.edit.mockResolvedValue(editedMessage);

    const response = await request(createAuthenticatedApp(messages))
      .patch(`/messages/${message.id}`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ body: '  Edited body  ' })
      .expect(200);

    expect(messages.edit).toHaveBeenCalledWith(userId, {
      messageId: message.id,
      body: 'Edited body',
    });
    expect(response.body.data.message).toMatchObject({ id: message.id, body: 'Edited body' });
  });

  it('returns the canonical tombstone after deletion', async () => {
    const messages = createMessages();
    const deletedMessage = { ...message, body: null, deletedAt: new Date() };
    messages.delete.mockResolvedValue(deletedMessage);

    const response = await request(createAuthenticatedApp(messages))
      .delete(`/messages/${message.id}`)
      .set('authorization', 'Bearer valid-access-token')
      .expect(200);

    expect(messages.delete).toHaveBeenCalledWith(userId, { messageId: message.id });
    expect(response.body.data.message).toMatchObject({
      id: message.id,
      body: null,
      deletedAt: expect.any(String),
    });
  });

  it('rejects invalid, unrelated, and unauthenticated mutation inputs', async () => {
    const messages = createMessages();
    const app = createAuthenticatedApp(messages);
    const authorization = { authorization: 'Bearer valid-access-token' };

    await request(app)
      .patch('/messages/not-a-uuid')
      .set(authorization)
      .send({ body: 'Edited' })
      .expect(400);
    await request(app)
      .patch(`/messages/${message.id}`)
      .set(authorization)
      .send({ body: ' ', senderId: userId })
      .expect(400);
    await request(createApp({ messages })).delete(`/messages/${message.id}`).expect(401);

    expect(messages.edit).not.toHaveBeenCalled();
    expect(messages.delete).not.toHaveBeenCalled();
  });
});
