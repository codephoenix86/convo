import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../../src/lib/errors.js';
import { createMessagesRepository } from '../../src/modules/messages/messages.repository.js';

const userId = randomUUID();
const conversationId = randomUUID();
const clientMessageId = randomUUID();
const messageId = randomUUID();
const createdAt = new Date('2026-09-02T10:00:00.000Z');
const storedMessage = { id: messageId, conversationId, senderId: userId, createdAt };

describe('messages repository', () => {
  it('creates a message and bumps inbox ordering only for a current member', async () => {
    const database = {
      conversation: {
        update: vi.fn().mockResolvedValue({ messages: [storedMessage] }),
      },
    };
    const repository = createMessagesRepository(database);

    const result = await repository.create({
      conversationId,
      senderId: userId,
      clientMessageId,
      body: 'Hello',
      replyToId: null,
    });

    expect(database.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId, members: { some: { userId } } },
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
          messages: {
            create: {
              senderId: userId,
              clientMessageId,
              body: 'Hello',
              type: 'TEXT',
              replyToId: null,
            },
          },
        }),
      }),
    );
    expect(result).toEqual({ message: storedMessage, created: true });
  });

  it('returns the existing canonical message after an idempotent retry', async () => {
    const database = {
      conversation: { update: vi.fn().mockRejectedValue({ code: 'P2002' }) },
      message: { findFirst: vi.fn().mockResolvedValue(storedMessage) },
    };
    const repository = createMessagesRepository(database);

    const result = await repository.create({
      conversationId,
      senderId: userId,
      clientMessageId,
      body: 'Changed retry body',
      replyToId: null,
    });

    expect(database.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          senderId: userId,
          clientMessageId,
          conversation: { members: { some: { userId } } },
        },
      }),
    );
    expect(result).toEqual({ message: storedMessage, created: false });
  });

  it('maps membership/unknown conversation failure without leaking existence', async () => {
    const database = {
      conversation: { update: vi.fn().mockRejectedValue({ code: 'P2025' }) },
    };
    const repository = createMessagesRepository(database);

    await expect(
      repository.create({ conversationId, senderId: userId, clientMessageId, body: 'Hi' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('uses the compound history order, membership predicate, and one lookahead row', async () => {
    const database = { message: { findMany: vi.fn().mockResolvedValue([]) } };
    const repository = createMessagesRepository(database);
    const cursor = { id: messageId, createdAt };

    await repository.listHistory({ conversationId, userId, cursor, limit: 30 });

    expect(database.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          conversation: { members: { some: { userId } } },
          OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: messageId } }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 31,
      }),
    );
  });

  it('atomically advances a read position using canonical message order', async () => {
    const readState = {
      conversationId,
      userId,
      lastReadMessageId: messageId,
      lastReadAt: createdAt,
    };
    const database = {
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: messageId, createdAt }),
      },
      conversationMember: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(readState),
      },
    };
    const repository = createMessagesRepository(database);

    await expect(
      repository.advanceReadPosition({ conversationId, userId, messageId }),
    ).resolves.toBe(readState);
    expect(database.message.findFirst).toHaveBeenCalledWith({
      where: { id: messageId, conversationId },
      select: { id: true, createdAt: true },
    });
    expect(database.conversationMember.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId,
        userId,
        OR: [
          { lastReadAt: null },
          { lastReadAt: { lt: createdAt } },
          { lastReadAt: createdAt, lastReadMessageId: { lt: messageId } },
        ],
      },
      data: { lastReadMessageId: messageId, lastReadAt: createdAt },
    });
  });

  it('rejects a read target outside the requested conversation', async () => {
    const database = {
      message: { findFirst: vi.fn().mockResolvedValue(null) },
      conversationMember: { updateMany: vi.fn(), findUnique: vi.fn() },
    };
    const repository = createMessagesRepository(database);

    await expect(
      repository.advanceReadPosition({ conversationId, userId, messageId }),
    ).rejects.toEqual(
      expect.objectContaining({ name: NotFoundError.name, message: 'Message not found' }),
    );
    expect(database.conversationMember.updateMany).not.toHaveBeenCalled();
  });
});
