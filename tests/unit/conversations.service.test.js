import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '../../src/lib/errors.js';
import { createConversationsService } from '../../src/modules/conversations/conversations.service.js';

const firstUserId = '01990a2d-6b80-7000-8000-000000000001';
const secondUserId = '01990a2d-6b80-7000-8000-000000000002';
const conversationId = randomUUID();
const createdAt = new Date('2026-09-01T12:00:00.000Z');
const updatedAt = new Date('2026-09-01T12:05:00.000Z');

function createConversation(overrides = {}) {
  return {
    id: conversationId,
    type: 'DIRECT',
    name: null,
    imageUrl: null,
    createdById: firstUserId,
    createdAt,
    updatedAt,
    members: [
      {
        role: 'MEMBER',
        joinedAt: createdAt,
        lastReadAt: null,
        user: { id: firstUserId, username: 'first', avatarUrl: null },
      },
      {
        role: 'MEMBER',
        joinedAt: createdAt,
        lastReadAt: null,
        user: { id: secondUserId, username: 'second', avatarUrl: null },
      },
    ],
    messages: [],
    ...overrides,
  };
}

describe('conversations service', () => {
  it.each([
    [firstUserId, secondUserId],
    [secondUserId, firstUserId],
  ])(
    'uses the same canonical key regardless of participant order',
    async (creatorId, participantId) => {
      const repository = { createOrGetDirect: vi.fn().mockResolvedValue(createConversation()) };
      const service = createConversationsService(repository);

      await service.createDirect(creatorId, participantId);

      expect(repository.createOrGetDirect).toHaveBeenCalledWith({
        creatorId,
        participantId,
        directKey: `${firstUserId}:${secondUserId}`,
      });
    },
  );

  it('rejects a direct conversation with oneself before querying the database', async () => {
    const repository = { createOrGetDirect: vi.fn() };
    const service = createConversationsService(repository);

    await expect(service.createDirect(firstUserId, firstUserId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repository.createOrGetDirect).not.toHaveBeenCalled();
  });

  it('formats a bounded inbox page with unread counts and a stable next cursor', async () => {
    const repository = {
      listForUser: vi.fn().mockResolvedValue({
        conversations: [createConversation()],
        hasNextPage: true,
        unreadCounts: new Map([[conversationId, 3]]),
      }),
    };
    const service = createConversationsService(repository);

    const firstPage = await service.list(firstUserId, { limit: 20 });

    expect(firstPage.items[0]).toMatchObject({
      id: conversationId,
      lastMessage: null,
      unreadCount: 3,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    repository.listForUser.mockResolvedValue({
      conversations: [],
      hasNextPage: false,
      unreadCounts: new Map(),
    });
    await service.list(firstUserId, { cursor: firstPage.nextCursor, limit: 20 });

    expect(repository.listForUser).toHaveBeenLastCalledWith({
      userId: firstUserId,
      cursor: { id: conversationId, updatedAt },
      limit: 20,
    });
  });

  it('creates a group with the authenticated user as its implicit owner', async () => {
    const group = createConversation({ type: 'GROUP', name: 'Backend Team' });
    const repository = { createGroup: vi.fn().mockResolvedValue(group) };
    const service = createConversationsService(repository);

    const result = await service.createGroup(firstUserId, {
      name: 'Backend Team',
      memberIds: [secondUserId],
    });

    expect(repository.createGroup).toHaveBeenCalledWith({
      creatorId: firstUserId,
      name: 'Backend Team',
      imageUrl: null,
      memberIds: [secondUserId],
    });
    expect(result).toMatchObject({ type: 'GROUP', name: 'Backend Team' });
  });

  it('rejects a group member list that repeats its implicit owner', async () => {
    const repository = { createGroup: vi.fn() };
    const service = createConversationsService(repository);

    await expect(
      service.createGroup(firstUserId, {
        name: 'Backend Team',
        memberIds: [firstUserId],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.createGroup).not.toHaveBeenCalled();
  });

  it('delegates authorized group metadata updates to an atomic repository write', async () => {
    const updatedGroup = createConversation({ type: 'GROUP', name: 'Renamed Team' });
    const repository = {
      findAccessContext: vi.fn().mockResolvedValue({
        id: conversationId,
        type: 'GROUP',
        members: [{ userId: firstUserId, role: 'OWNER' }],
      }),
      updateGroup: vi.fn().mockResolvedValue(updatedGroup),
    };
    const service = createConversationsService(repository);

    const result = await service.updateGroup(firstUserId, conversationId, {
      name: 'Renamed Team',
    });

    expect(repository.updateGroup).toHaveBeenCalledWith({
      actorId: firstUserId,
      conversationId,
      changes: { name: 'Renamed Team' },
    });
    expect(result.name).toBe('Renamed Team');
  });
});
