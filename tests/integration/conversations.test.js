import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const userId = randomUUID();
const participantId = randomUUID();
const conversationId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const conversation = {
  id: conversationId,
  type: 'DIRECT',
  name: null,
  imageUrl: null,
  createdById: userId,
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  members: [
    {
      role: 'MEMBER',
      joinedAt: new Date('2026-09-01T12:00:00.000Z'),
      user: { id: userId, username: 'first_user', avatarUrl: null },
    },
    {
      role: 'MEMBER',
      joinedAt: new Date('2026-09-01T12:00:00.000Z'),
      user: { id: participantId, username: 'second_user', avatarUrl: null },
    },
  ],
  lastMessage: null,
};

function createConversations() {
  return {
    createDirect: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    list: vi.fn(),
  };
}

function createAuthenticatedApp(conversations) {
  return createApp({
    conversations,
    accessTokenVerifier: vi.fn().mockResolvedValue(accessClaims),
  });
}

describe('POST /conversations/direct', () => {
  it('creates or returns the canonical conversation for the authenticated user', async () => {
    const conversations = createConversations();
    conversations.createDirect.mockResolvedValue(conversation);

    const response = await request(createAuthenticatedApp(conversations))
      .post('/conversations/direct')
      .set('authorization', 'Bearer valid-access-token')
      .send({ userId: participantId })
      .expect(200);

    expect(conversations.createDirect).toHaveBeenCalledWith(userId, participantId);
    expect(response.body.data.conversation).toMatchObject({
      id: conversationId,
      type: 'DIRECT',
      lastMessage: null,
    });
    expect(response.text).not.toContain('password');
    expect(response.text).not.toContain('email');
  });

  it('rejects invalid participant IDs before calling conversation logic', async () => {
    const conversations = createConversations();

    const response = await request(createAuthenticatedApp(conversations))
      .post('/conversations/direct')
      .set('authorization', 'Bearer valid-access-token')
      .send({ userId: 'not-a-uuid' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(conversations.createDirect).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated creation attempts', async () => {
    const conversations = createConversations();

    await request(createApp({ conversations }))
      .post('/conversations/direct')
      .send({ userId: participantId })
      .expect(401);

    expect(conversations.createDirect).not.toHaveBeenCalled();
  });
});

describe('GET /conversations', () => {
  it('returns the authenticated inbox with bounded pagination', async () => {
    const conversations = createConversations();
    conversations.list.mockResolvedValue({
      items: [{ ...conversation, unreadCount: 2 }],
      nextCursor: 'next-cursor',
    });

    const response = await request(createAuthenticatedApp(conversations))
      .get('/conversations')
      .set('authorization', 'Bearer valid-access-token')
      .query({ limit: 25 })
      .expect(200);

    expect(conversations.list).toHaveBeenCalledWith(userId, {
      cursor: undefined,
      limit: 25,
    });
    expect(response.body.data).toMatchObject({
      items: [{ id: conversationId, unreadCount: 2 }],
      nextCursor: 'next-cursor',
    });
  });

  it('rejects unbounded page sizes before querying conversations', async () => {
    const conversations = createConversations();

    await request(createAuthenticatedApp(conversations))
      .get('/conversations')
      .set('authorization', 'Bearer valid-access-token')
      .query({ limit: 100 })
      .expect(400);

    expect(conversations.list).not.toHaveBeenCalled();
  });
});

describe('POST /conversations/group', () => {
  it('creates a normalized group with initial members', async () => {
    const conversations = createConversations();
    conversations.createGroup.mockResolvedValue({
      ...conversation,
      type: 'GROUP',
      name: 'Backend Team',
    });

    const response = await request(createAuthenticatedApp(conversations))
      .post('/conversations/group')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        name: ' Backend Team ',
        imageUrl: ' https://example.com/group.png ',
        memberIds: [participantId],
      })
      .expect(201);

    expect(conversations.createGroup).toHaveBeenCalledWith(userId, {
      name: 'Backend Team',
      imageUrl: 'https://example.com/group.png',
      memberIds: [participantId],
    });
    expect(response.body.data.conversation).toMatchObject({
      type: 'GROUP',
      name: 'Backend Team',
    });
  });

  it('rejects duplicate members and unsafe image URLs before creating a group', async () => {
    const conversations = createConversations();

    await request(createAuthenticatedApp(conversations))
      .post('/conversations/group')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        name: 'Backend Team',
        imageUrl: 'file:///etc/passwd',
        memberIds: [participantId, participantId],
      })
      .expect(400);

    expect(conversations.createGroup).not.toHaveBeenCalled();
  });
});

describe('PATCH /conversations/:id', () => {
  it('updates only normalized group metadata', async () => {
    const conversations = createConversations();
    conversations.updateGroup.mockResolvedValue({
      ...conversation,
      type: 'GROUP',
      name: 'Renamed Team',
    });

    const response = await request(createAuthenticatedApp(conversations))
      .patch(`/conversations/${conversationId}`)
      .set('authorization', 'Bearer valid-access-token')
      .send({ name: ' Renamed Team ', imageUrl: null })
      .expect(200);

    expect(conversations.updateGroup).toHaveBeenCalledWith(userId, conversationId, {
      name: 'Renamed Team',
      imageUrl: null,
    });
    expect(response.body.data.conversation.name).toBe('Renamed Team');
  });

  it('rejects invalid IDs, empty updates, and unrelated fields', async () => {
    const conversations = createConversations();
    const app = createAuthenticatedApp(conversations);
    const authorization = { authorization: 'Bearer valid-access-token' };

    await request(app)
      .patch('/conversations/not-a-uuid')
      .set(authorization)
      .send({ name: 'Renamed Team' })
      .expect(400);
    await request(app)
      .patch(`/conversations/${conversationId}`)
      .set(authorization)
      .send({})
      .expect(400);
    await request(app)
      .patch(`/conversations/${conversationId}`)
      .set(authorization)
      .send({ type: 'DIRECT' })
      .expect(400);

    expect(conversations.updateGroup).not.toHaveBeenCalled();
  });
});
