import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '../../src/lib/cursor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/lib/errors.js';
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
    findMutationContext: vi.fn(),
    edit: vi.fn(),
    softDelete: vi.fn(),
  };
  const accessRepository = {
    findAccessContext: vi.fn().mockResolvedValue(context),
  };
  const messageEvents = {
    messageCreated: vi.fn(),
    messageDelivered: vi.fn(),
    conversationRead: vi.fn(),
    messageEdited: vi.fn(),
    messageDeleted: vi.fn(),
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

  it('redacts deleted message bodies from history', async () => {
    const fixture = createFixture();
    fixture.repository.listHistory.mockResolvedValue([
      message({ body: 'Persisted tombstone body', deletedAt: createdAt }),
    ]);

    const result = await fixture.service.listHistory(userId, conversationId, { limit: 30 });

    expect(result.items[0]).toMatchObject({ body: null, deletedAt: createdAt });
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

  it('edits an owned text message and publishes the canonical change', async () => {
    const fixture = createFixture();
    const original = message();
    const edited = message({ ...original, body: 'Edited body', editedAt: createdAt });
    fixture.repository.findMutationContext.mockResolvedValue(original);
    fixture.repository.edit.mockResolvedValue(edited);

    await expect(
      fixture.service.edit(userId, { messageId: original.id, body: '  Edited body  ' }),
    ).resolves.toBe(edited);
    expect(fixture.repository.edit).toHaveBeenCalledWith({
      conversationId,
      messageId: original.id,
      userId,
      body: 'Edited body',
    });
    expect(fixture.messageEvents.messageEdited).toHaveBeenCalledWith({ message: edited });
  });

  it('soft deletes an owned message and publishes a redacted tombstone', async () => {
    const fixture = createFixture();
    const original = message();
    const deleted = message({ ...original, deletedAt: createdAt });
    fixture.repository.findMutationContext.mockResolvedValue(original);
    fixture.repository.softDelete.mockResolvedValue(deleted);

    const result = await fixture.service.delete(userId, { messageId: original.id });

    expect(result).toEqual({ ...deleted, body: null });
    expect(fixture.repository.softDelete).toHaveBeenCalledWith({
      conversationId,
      messageId: original.id,
      userId,
    });
    expect(fixture.messageEvents.messageDeleted).toHaveBeenCalledWith({ message: result });
  });

  it('does not rewrite or republish idempotent edit and delete retries', async () => {
    const fixture = createFixture();
    const edited = message({ body: 'Already edited', editedAt: createdAt });
    fixture.repository.findMutationContext
      .mockResolvedValueOnce(edited)
      .mockResolvedValueOnce(message({ ...edited, deletedAt: createdAt }));

    await fixture.service.edit(userId, { messageId: edited.id, body: 'Already edited' });
    const deletedRetry = await fixture.service.delete(userId, { messageId: edited.id });

    expect(deletedRetry.body).toBeNull();
    expect(fixture.repository.edit).not.toHaveBeenCalled();
    expect(fixture.repository.softDelete).not.toHaveBeenCalled();
    expect(fixture.messageEvents.messageEdited).not.toHaveBeenCalled();
    expect(fixture.messageEvents.messageDeleted).not.toHaveBeenCalled();
  });

  it('denies message mutations to nonmembers and nonsenders', async () => {
    const fixture = createFixture();
    const anotherUserId = randomUUID();

    fixture.repository.findMutationContext.mockResolvedValueOnce(null);
    await expect(
      fixture.service.edit(userId, { messageId: randomUUID(), body: 'Edited' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    fixture.repository.findMutationContext.mockResolvedValueOnce(
      message({ senderId: anotherUserId }),
    );
    await expect(
      fixture.service.delete(userId, { messageId: randomUUID() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fixture.repository.edit).not.toHaveBeenCalled();
    expect(fixture.repository.softDelete).not.toHaveBeenCalled();
  });

  it('rejects deleted/system edits and invalid mutation payloads', async () => {
    const fixture = createFixture();
    const messageId = randomUUID();

    await expect(
      fixture.service.edit(userId, { messageId: 'invalid', body: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.repository.findMutationContext).not.toHaveBeenCalled();

    fixture.repository.findMutationContext.mockResolvedValueOnce(
      message({ id: messageId, deletedAt: createdAt }),
    );
    await expect(
      fixture.service.edit(userId, { messageId, body: 'Edited' }),
    ).rejects.toBeInstanceOf(ConflictError);

    fixture.repository.findMutationContext.mockResolvedValueOnce(
      message({ id: messageId, type: 'SYSTEM' }),
    );
    await expect(fixture.service.delete(userId, { messageId })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
