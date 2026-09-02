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
  };
  const accessRepository = {
    findAccessContext: vi.fn().mockResolvedValue(context),
  };
  const service = createMessagesService({ repository, accessRepository });

  return { repository, accessRepository, service };
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
      fixture.service.create(userId, conversationId, {
        clientMessageId,
        body: 'Hello',
      }),
    ).resolves.toBe(result);

    expect(fixture.repository.create).toHaveBeenCalledWith({
      conversationId,
      senderId: userId,
      clientMessageId,
      body: 'Hello',
      replyToId: null,
    });
  });

  it('denies creation and history to nonmembers before message queries', async () => {
    const fixture = createFixture({ id: conversationId, type: 'DIRECT', members: [] });

    await expect(
      fixture.service.create(userId, conversationId, { clientMessageId, body: 'Hello' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      fixture.service.listHistory(userId, conversationId, { limit: 30 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.repository.create).not.toHaveBeenCalled();
    expect(fixture.repository.listHistory).not.toHaveBeenCalled();
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
});
