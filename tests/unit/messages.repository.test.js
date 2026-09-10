import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError } from '../../src/lib/errors.js';
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

  it('creates attachment rows atomically with their message', async () => {
    const attachment = {
      storageKey: `conversations/${conversationId}/users/${userId}/${randomUUID()}.png`,
      mimeType: 'image/png',
      size: 2048,
      width: 640,
      height: 480,
    };
    const database = {
      conversation: { update: vi.fn().mockResolvedValue({ messages: [storedMessage] }) },
    };
    const repository = createMessagesRepository(database);

    await repository.create({
      conversationId,
      senderId: userId,
      clientMessageId,
      body: 'Attached image',
      replyToId: null,
      attachments: [attachment],
    });

    expect(database.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messages: {
            create: {
              senderId: userId,
              clientMessageId,
              body: 'Attached image',
              type: 'TEXT',
              replyToId: null,
              attachments: { create: [attachment] },
            },
          },
        }),
      }),
    );
  });

  it('maps reuse of an attachment by another message to a conflict', async () => {
    const database = {
      conversation: { update: vi.fn().mockRejectedValue({ code: 'P2002' }) },
      message: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const repository = createMessagesRepository(database);

    await expect(
      repository.create({
        conversationId,
        senderId: userId,
        clientMessageId,
        body: 'Duplicate attachment',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: ConflictError.name,
        message: 'An attachment has already been used',
      }),
    );
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

  it('loads mutation context only for a current conversation member', async () => {
    const database = { message: { findFirst: vi.fn().mockResolvedValue(storedMessage) } };
    const repository = createMessagesRepository(database);

    await expect(repository.findMutationContext({ messageId, userId })).resolves.toBe(
      storedMessage,
    );
    expect(database.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: messageId,
          conversation: { members: { some: { userId } } },
        },
      }),
    );
  });

  it('edits a current member-owned text message and bumps inbox synchronization', async () => {
    const editedMessage = { ...storedMessage, body: 'Edited body', editedAt: new Date() };
    const database = {
      conversation: { update: vi.fn().mockResolvedValue({ messages: [editedMessage] }) },
    };
    const repository = createMessagesRepository(database);

    await expect(
      repository.edit({ conversationId, messageId, userId, body: 'Edited body' }),
    ).resolves.toBe(editedMessage);
    expect(database.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId, members: { some: { userId } } },
        data: {
          updatedAt: expect.any(Date),
          messages: {
            update: {
              where: { id: messageId, senderId: userId, type: 'TEXT', deletedAt: null },
              data: { body: 'Edited body', editedAt: expect.any(Date) },
            },
          },
        },
      }),
    );
  });

  it('soft deletes a current member-owned message and maps race failures safely', async () => {
    const deletedMessage = { ...storedMessage, deletedAt: new Date() };
    const database = {
      conversation: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ messages: [deletedMessage] })
          .mockRejectedValueOnce({ code: 'P2025' }),
      },
    };
    const repository = createMessagesRepository(database);

    await expect(repository.softDelete({ conversationId, messageId, userId })).resolves.toBe(
      deletedMessage,
    );
    expect(database.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId, members: { some: { userId } } },
        data: {
          updatedAt: expect.any(Date),
          messages: {
            update: {
              where: { id: messageId, senderId: userId, type: 'TEXT', deletedAt: null },
              data: { deletedAt: expect.any(Date) },
            },
          },
        },
      }),
    );

    await expect(repository.softDelete({ conversationId, messageId, userId })).rejects.toEqual(
      expect.objectContaining({ name: NotFoundError.name, message: 'Message not found' }),
    );
  });

  it('atomically advances a read position using canonical message order', async () => {
    const readState = {
      conversationId,
      userId,
      lastDeliveredMessageId: messageId,
      lastDeliveredAt: createdAt,
      lastReadMessageId: messageId,
      lastReadAt: createdAt,
    };
    const transaction = {
      message: {
        findFirst: vi.fn().mockResolvedValue({ id: messageId, createdAt }),
      },
      conversationMember: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(readState),
      },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createMessagesRepository(database);

    await expect(
      repository.advanceReadPosition({ conversationId, userId, messageId }),
    ).resolves.toEqual({
      receipt: {
        conversationId,
        userId,
        lastReadMessageId: messageId,
        lastReadAt: createdAt,
      },
      advanced: true,
    });
    expect(transaction.message.findFirst).toHaveBeenCalledWith({
      where: { id: messageId, conversationId },
      select: { id: true, createdAt: true },
    });
    expect(transaction.conversationMember.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        conversationId,
        userId,
        OR: [
          { lastDeliveredAt: null },
          { lastDeliveredAt: { lt: createdAt } },
          {
            lastDeliveredAt: createdAt,
            lastDeliveredMessageId: { lt: messageId },
          },
        ],
      },
      data: { lastDeliveredMessageId: messageId, lastDeliveredAt: createdAt },
    });
    expect(transaction.conversationMember.updateMany).toHaveBeenNthCalledWith(2, {
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

  it('persists a delivery position without changing read state', async () => {
    const deliveredState = {
      conversationId,
      userId,
      lastDeliveredMessageId: messageId,
      lastDeliveredAt: createdAt,
    };
    const transaction = {
      message: { findFirst: vi.fn().mockResolvedValue({ id: messageId, createdAt }) },
      conversationMember: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(deliveredState),
      },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createMessagesRepository(database);

    await expect(
      repository.advanceDeliveredPosition({ conversationId, userId, messageId }),
    ).resolves.toEqual({ receipt: deliveredState, advanced: false });
    expect(transaction.conversationMember.updateMany).toHaveBeenCalledOnce();
    expect(transaction.conversationMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          conversationId: true,
          userId: true,
          lastDeliveredMessageId: true,
          lastDeliveredAt: true,
        },
      }),
    );
  });

  it('rejects a read target outside the requested conversation', async () => {
    const transaction = {
      message: { findFirst: vi.fn().mockResolvedValue(null) },
      conversationMember: { updateMany: vi.fn(), findUnique: vi.fn() },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createMessagesRepository(database);

    await expect(
      repository.advanceReadPosition({ conversationId, userId, messageId }),
    ).rejects.toEqual(
      expect.objectContaining({ name: NotFoundError.name, message: 'Message not found' }),
    );
    expect(transaction.conversationMember.updateMany).not.toHaveBeenCalled();
  });
});
