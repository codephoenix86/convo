import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../../src/lib/errors.js';
import { createConversationsRepository } from '../../src/modules/conversations/conversations.repository.js';

const userId = randomUUID();
const participantId = randomUUID();
const conversationId = randomUUID();
const joinedAt = new Date('2026-09-01T12:00:00.000Z');
const updatedAt = new Date('2026-09-01T12:05:00.000Z');

describe('conversations repository', () => {
  it('creates or reuses a direct conversation and both memberships in one transaction', async () => {
    const conversation = { id: conversationId };
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: participantId }) },
      conversation: { upsert: vi.fn().mockResolvedValue(conversation) },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createConversationsRepository(database);
    const directKey = [userId, participantId].sort().join(':');

    const result = await repository.createOrGetDirect({
      creatorId: userId,
      participantId,
      directKey,
    });

    expect(result).toBe(conversation);
    expect(transaction.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { directKey },
        update: {},
        create: {
          type: 'DIRECT',
          directKey,
          createdById: userId,
          members: {
            create: [
              { userId, role: 'MEMBER' },
              { userId: participantId, role: 'MEMBER' },
            ],
          },
        },
      }),
    );
  });

  it('rejects an unknown participant without creating partial state', async () => {
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      conversation: { upsert: vi.fn() },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createConversationsRepository(database);

    await expect(
      repository.createOrGetDirect({
        creatorId: userId,
        participantId,
        directKey: [userId, participantId].sort().join(':'),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(transaction.conversation.upsert).not.toHaveBeenCalled();
  });

  it('loads a bounded page then computes unread counts in one grouped query', async () => {
    const conversation = {
      id: conversationId,
      updatedAt,
      members: [
        {
          joinedAt,
          lastReadAt: null,
          user: { id: userId },
        },
      ],
    };
    const database = {
      conversation: { findMany: vi.fn().mockResolvedValue([conversation]) },
      message: {
        groupBy: vi.fn().mockResolvedValue([{ conversationId, _count: { _all: 4 } }]),
      },
    };
    const repository = createConversationsRepository(database);

    const result = await repository.listForUser({ userId, limit: 20 });

    expect(database.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { members: { some: { userId } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(database.message.groupBy).toHaveBeenCalledWith({
      by: ['conversationId'],
      where: {
        senderId: { not: userId },
        deletedAt: null,
        OR: [{ conversationId, createdAt: { gt: joinedAt } }],
      },
      _count: { _all: true },
    });
    expect(result.unreadCounts.get(conversationId)).toBe(4);
  });

  it('creates the group and all validated memberships atomically', async () => {
    const createdGroup = { id: conversationId, type: 'GROUP' };
    const transaction = {
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: participantId }]),
      },
      conversation: {
        create: vi.fn().mockResolvedValue(createdGroup),
      },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createConversationsRepository(database);

    const result = await repository.createGroup({
      creatorId: userId,
      name: 'Backend Team',
      imageUrl: null,
      memberIds: [participantId],
    });

    expect(result).toBe(createdGroup);
    expect(transaction.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: 'GROUP',
          name: 'Backend Team',
          imageUrl: null,
          createdById: userId,
          members: {
            create: [
              { userId, role: 'OWNER' },
              { userId: participantId, role: 'MEMBER' },
            ],
          },
        },
      }),
    );
  });

  it('does not create a partial group when any requested user is missing', async () => {
    const transaction = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      conversation: { create: vi.fn() },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createConversationsRepository(database);

    await expect(
      repository.createGroup({
        creatorId: userId,
        name: 'Backend Team',
        imageUrl: null,
        memberIds: [participantId],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(transaction.conversation.create).not.toHaveBeenCalled();
  });

  it('updates group metadata only when the actor is its owner or an admin', async () => {
    const database = {
      conversation: { update: vi.fn().mockResolvedValue({ id: conversationId }) },
    };
    const repository = createConversationsRepository(database);

    await repository.updateGroup({
      conversationId,
      actorId: userId,
      changes: { name: 'Renamed Team' },
    });

    expect(database.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: conversationId,
          type: 'GROUP',
          members: {
            some: {
              userId,
              role: { in: ['OWNER', 'ADMIN'] },
            },
          },
        },
        data: { name: 'Renamed Team' },
      }),
    );
  });

  it('hides nonexistent, direct, nonmember, and member-only conversations identically', async () => {
    const database = {
      conversation: { update: vi.fn().mockRejectedValue({ code: 'P2025' }) },
    };
    const repository = createConversationsRepository(database);

    await expect(
      repository.updateGroup({
        conversationId,
        actorId: userId,
        changes: { name: 'Renamed Team' },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: NotFoundError.name,
        message: 'Conversation not found',
      }),
    );
  });
});
