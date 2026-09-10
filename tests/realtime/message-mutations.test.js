import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessagesService } from '../../src/modules/messages/messages.service.js';
import { createConversationRoomCoordinator } from '../../src/realtime/conversation-rooms.js';
import { createRealtimeMessageEvents } from '../../src/realtime/message-events.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const senderId = randomUUID();
const recipientId = randomUUID();
const outsiderId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const clientMessageId = randomUUID();
const tokenUsers = new Map([
  ['sender-token', senderId],
  ['recipient-token', recipientId],
  ['outsider-token', outsiderId],
]);

describe('message edit and delete socket events', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;
  let repository;
  let storedMessage;

  beforeEach(async () => {
    clients = [];
    const timestamp = new Date('2026-09-10T10:00:00.000Z');
    storedMessage = {
      id: messageId,
      conversationId,
      senderId,
      clientMessageId,
      body: 'Original body',
      type: 'TEXT',
      replyToId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: null,
      deletedAt: null,
      sender: { id: senderId, username: 'sender', avatarUrl: null },
    };
    const accessTokenVerifier = vi.fn(async (token) => ({
      userId: tokenUsers.get(token),
      sessionId: randomUUID(),
      tokenId: randomUUID(),
    }));
    const accessRepository = {
      listConversationIdsForUser: vi.fn(async (userId) =>
        [senderId, recipientId].includes(userId) ? [conversationId] : [],
      ),
      findAccessContext: vi.fn(),
    };
    repository = {
      create: vi.fn(),
      listHistory: vi.fn(),
      advanceDeliveredPosition: vi.fn(),
      advanceReadPosition: vi.fn(),
      findMutationContext: vi.fn(async ({ userId }) =>
        [senderId, recipientId].includes(userId) ? storedMessage : null,
      ),
      edit: vi.fn(async ({ body }) => {
        const editedAt = new Date('2026-09-10T10:01:00.000Z');
        storedMessage = { ...storedMessage, body, editedAt, updatedAt: editedAt };

        return storedMessage;
      }),
      softDelete: vi.fn(async () => {
        const deletedAt = new Date('2026-09-10T10:02:00.000Z');
        storedMessage = { ...storedMessage, deletedAt, updatedAt: deletedAt };

        return storedMessage;
      }),
    };
    const messageEvents = createRealtimeMessageEvents();
    const messages = createMessagesService({
      repository,
      accessRepository,
      messageEvents,
    });
    const roomCoordinator = createConversationRoomCoordinator();

    httpServer = createServer();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier,
      membershipRepository: accessRepository,
      roomCoordinator,
      messages,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    messageEvents.attach(socketServer);

    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const address = httpServer.address();
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }

    await new Promise((resolve) => socketServer.close(resolve));
  });

  it('acknowledges and broadcasts a sender-owned edit', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const editedEvent = once(recipient, 'message:edited');

    const acknowledgement = await sender.timeout(1000).emitWithAck('message:edit', {
      messageId,
      body: '  Edited body  ',
    });

    expect(acknowledgement).toEqual({
      ok: true,
      data: { message: serializeMessage(storedMessage) },
    });
    await expect(editedEvent).resolves.toEqual([{ message: serializeMessage(storedMessage) }]);
    expect(repository.edit).toHaveBeenCalledWith({
      conversationId,
      messageId,
      userId: senderId,
      body: 'Edited body',
    });
  });

  it('rejects mutation by another member or a nonmember', async () => {
    const recipient = await connectClient('recipient-token');
    const memberResult = await recipient.timeout(1000).emitWithAck('message:delete', {
      messageId,
    });

    expect(memberResult).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Only the message sender can modify it' },
    });

    const outsider = await connectClient('outsider-token');
    const outsiderResult = await outsider.timeout(1000).emitWithAck('message:edit', {
      messageId,
      body: 'Unauthorized edit',
    });

    expect(outsiderResult).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Message not found' },
    });
    expect(repository.edit).not.toHaveBeenCalled();
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('broadcasts one redacted tombstone and treats deletion retries idempotently', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const deletedEvents = [];
    recipient.on('message:deleted', (event) => deletedEvents.push(event));

    const firstAcknowledgement = await sender
      .timeout(1000)
      .emitWithAck('message:delete', { messageId });

    expect(firstAcknowledgement).toMatchObject({
      ok: true,
      data: { message: { id: messageId, body: null, deletedAt: expect.any(String) } },
    });
    await waitFor(() => deletedEvents.length === 1);
    expect(deletedEvents[0]).toMatchObject({
      message: { id: messageId, body: null, deletedAt: expect.any(String) },
    });

    const retryAcknowledgement = await sender
      .timeout(1000)
      .emitWithAck('message:delete', { messageId });

    expect(retryAcknowledgement).toEqual(firstAcknowledgement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deletedEvents).toHaveLength(1);
    expect(repository.softDelete).toHaveBeenCalledOnce();
  });

  it('rejects malformed mutation payloads before repository access', async () => {
    const sender = await connectClient('sender-token');
    repository.findMutationContext.mockClear();

    const acknowledgement = await sender.timeout(1000).emitWithAck('message:edit', {
      messageId: 'invalid',
      body: ' ',
      senderId,
    });

    expect(acknowledgement).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Message validation failed' },
    });
    expect(repository.findMutationContext).not.toHaveBeenCalled();
  });

  async function connectClient(token) {
    const client = createClient(serverUrl, {
      auth: { token },
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });

    clients.push(client);
    client.connect();
    await once(client, 'connect');

    return client;
  }
});

function serializeMessage(message) {
  return Object.fromEntries(
    Object.entries(message).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Condition was not met within ${timeoutMs}ms`));
      }
    }, 10);
  });
}
