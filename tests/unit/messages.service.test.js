import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '../../src/lib/cursor.js';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { createMessagesService } from '../../src/modules/messages/messages.service.js';

const userId = randomUUID();
const conversationId = randomUUID();
const clientMessageId = randomUUID();
const createdAt = new Date('2026-09-02T10:00:00.000Z');

function createFixture(context = memberContext()) {
  const repository = {
    create: vi.fn(),
    listHistory: vi.fn(),
    advanceDeliveredPosition: vi.fn(),
    advanceReadPosition: vi.fn(),
  };
  const accessRepository = {
    findAccessContext: vi.fn().mockResolvedValue(context),
  };
  const messageEvents = {
    messageCreated: vi.fn(),
    messageDelivered: vi.fn(),
    conversationRead: vi.fn(),
  };
  const service = createMessagesService({ repository, accessRepository, messageEvents });

  return { repository, accessRepository, messageEvents, service };
}

function memberContext() {
  return {
    id: conversationId,
    type: 'DIRECT',
    members: [{ userId, role: 'MEMBER' }],
  };
}

function message(overrides = {}) {
  return {
    id: randomUUID(),
    conversationId,
    senderId: userId,
    clientMessageId,
    body: 'Hello',
    type: 'TEXT',
    replyToId: null,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('messages service', () => {
  it('uses one transport-independent path for authorized idempotent creation', async () => {
    const fixture = createFixture();
    const result = { message: message(), created: true };
    fixture.repository.create.mockResolvedValue(result);

    await expect(
      fixture.service.send(userId, {
        conversationId,
        clientMessageId,
        body: '  Hello  ',
      }),
    ).resolves.toBe(result);

    expect(fixture.repository.create).toHaveBeenCalledWith({
      conversationId,
      senderId: userId,
      clientMessageId,
      body: 'Hello',
      replyToId: null,
    });
    expect(fixture.messageEvents.messageCreated).toHaveBeenCalledWith({
      message: result.message,
    });
  });

  it('returns an idempotent retry without publishing a duplicate event', async () => {
    const fixture = createFixture();
    const result = { message: message(), created: false };
    fixture.repository.create.mockResolvedValue(result);

    await expect(
      fixture.service.send(userId, {
        conversationId,
        clientMessageId,
        body: 'Retry body is ignored by persistence',
      }),
    ).resolves.toBe(result);

    expect(fixture.messageEvents.messageCreated).not.toHaveBeenCalled();
  });

  it('validates the complete send command before authorization or persistence', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.send(userId, {
        conversationId: 'not-a-uuid',
        clientMessageId,
        body: '   ',
        senderId: userId,
      }),
    ).rejects.toMatchObject({
      name: ValidationError.name,
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'conversationId' }),
        expect.objectContaining({ field: 'body' }),
      ]),
    });
    expect(fixture.accessRepository.findAccessContext).not.toHaveBeenCalled();
    expect(fixture.repository.create).not.toHaveBeenCalled();
    expect(fixture.messageEvents.messageCreated).not.toHaveBeenCalled();
  });

  it('denies creation and history to nonmembers before message queries', async () => {
    const fixture = createFixture({ id: conversationId, type: 'DIRECT', members: [] });

    await expect(
      fixture.service.send(userId, { conversationId, clientMessageId, body: 'Hello' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      fixture.service.listHistory(userId, conversationId, { limit: 30 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.repository.create).not.toHaveBeenCalled();
    expect(fixture.repository.listHistory).not.toHaveBeenCalled();
    expect(fixture.messageEvents.messageCreated).not.toHaveBeenCalled();
  });

  it('returns deterministic older-message pages and a conversation-bound cursor', async () => {
    const fixture = createFixture();
    const rows = [
      message({ id: randomUUID(), createdAt: new Date('2026-09-02T10:03:00.000Z') }),
      message({ id: randomUUID(), createdAt: new Date('2026-09-02T10:02:00.000Z') }),
      message({ id: randomUUID(), createdAt: new Date('2026-09-02T10:01:00.000Z') }),
    ];
    fixture.repository.listHistory.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);

    const firstPage = await fixture.service.listHistory(userId, conversationId, { limit: 2 });

    expect(firstPage.items).toEqual(rows.slice(0, 2));
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await fixture.service.listHistory(userId, conversationId, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(fixture.repository.listHistory).toHaveBeenLastCalledWith({
      conversationId,
      userId,
      cursor: { id: rows[1].id, createdAt: rows[1].createdAt },
      limit: 2,
    });
  });

  it('rejects a cursor issued for another conversation', async () => {
    const fixture = createFixture();
    const cursor = encodeCursor({
      id: randomUUID(),
      conversationId: randomUUID(),
      createdAt: createdAt.toISOString(),
    });

    await expect(
      fixture.service.listHistory(userId, conversationId, { cursor, limit: 30 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.repository.listHistory).not.toHaveBeenCalled();
  });

  it('advances an authorized member read position through the shared service', async () => {
    const fixture = createFixture();
    const readMessageId = randomUUID();
    const readState = {
      conversationId,
      userId,
      lastReadMessageId: readMessageId,
      lastReadAt: createdAt,
    };
    fixture.repository.advanceReadPosition.mockResolvedValue({
      receipt: readState,
      advanced: true,
    });

    await expect(
      fixture.service.markRead(userId, { conversationId, messageId: readMessageId }),
    ).resolves.toBe(readState);
    expect(fixture.repository.advanceReadPosition).toHaveBeenCalledWith({
      conversationId,
      userId,
      messageId: readMessageId,
    });
    expect(fixture.messageEvents.conversationRead).toHaveBeenCalledWith({ receipt: readState });
  });

  it('persists and publishes an authorized delivery receipt', async () => {
    const fixture = createFixture();
    const deliveredMessageId = randomUUID();
    const receipt = {
      conversationId,
      userId,
      lastDeliveredMessageId: deliveredMessageId,
      lastDeliveredAt: createdAt,
    };
    fixture.repository.advanceDeliveredPosition.mockResolvedValue({
      receipt,
      advanced: true,
    });

    await expect(
      fixture.service.markDelivered(userId, {
        conversationId,
        messageId: deliveredMessageId,
      }),
    ).resolves.toBe(receipt);
    expect(fixture.messageEvents.messageDelivered).toHaveBeenCalledWith({ receipt });
  });

  it('does not republish an idempotent receipt retry', async () => {
    const fixture = createFixture();
    const readState = {
      conversationId,
      userId,
      lastReadMessageId: randomUUID(),
      lastReadAt: createdAt,
    };
    fixture.repository.advanceReadPosition.mockResolvedValue({
      receipt: readState,
      advanced: false,
    });

    await fixture.service.markRead(userId, {
      conversationId,
      messageId: readState.lastReadMessageId,
    });

    expect(fixture.messageEvents.conversationRead).not.toHaveBeenCalled();
  });

  it('validates and authorizes read updates before changing persisted state', async () => {
    const fixture = createFixture({ id: conversationId, type: 'DIRECT', members: [] });

    await expect(
      fixture.service.markRead(userId, { conversationId, messageId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.accessRepository.findAccessContext).not.toHaveBeenCalled();

    await expect(
      fixture.service.markRead(userId, { conversationId, messageId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.repository.advanceReadPosition).not.toHaveBeenCalled();

    await expect(
      fixture.service.markDelivered(userId, { conversationId, messageId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.repository.advanceDeliveredPosition).not.toHaveBeenCalled();
  });
});
