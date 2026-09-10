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
const clientMessageId = randomUUID();
const tokenUsers = new Map([
  ['sender-token', senderId],
  ['recipient-token', recipientId],
  ['outsider-token', outsiderId],
]);

describe('message:send', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;
  let accessRepository;
  let messageRepository;
  let storage;
  let log;
  let storedMessage;

  beforeEach(async () => {
    storedMessage = null;
    clients = [];
    log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const accessTokenVerifier = vi.fn(async (token) => ({
      userId: tokenUsers.get(token),
      sessionId: randomUUID(),
      tokenId: randomUUID(),
    }));
    accessRepository = {
      findAccessContext: vi.fn(async (requestedConversationId) =>
        requestedConversationId === conversationId
          ? {
              id: conversationId,
              type: 'DIRECT',
              members: [
                { userId: senderId, role: 'MEMBER' },
                { userId: recipientId, role: 'MEMBER' },
              ],
            }
          : null,
      ),
      listConversationIdsForUser: vi.fn(async (userId) =>
        [senderId, recipientId].includes(userId) ? [conversationId] : [],
      ),
    };
    messageRepository = {
      create: vi.fn(async (input) => {
        if (storedMessage) {
          return { message: storedMessage, created: false };
        }

        const timestamp = new Date('2026-09-02T10:00:00.000Z');
        storedMessage = {
          id: randomUUID(),
          conversationId: input.conversationId,
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
          body: input.body,
          type: 'TEXT',
          replyToId: input.replyToId,
          createdAt: timestamp,
          updatedAt: timestamp,
          editedAt: null,
          deletedAt: null,
          sender: { id: senderId, username: 'sender', avatarUrl: null },
          ...(input.attachments
            ? {
                attachments: input.attachments.map((attachment) => ({
                  id: randomUUID(),
                  ...attachment,
                  createdAt: timestamp,
                })),
              }
            : {}),
        };

        return { message: storedMessage, created: true };
      }),
      listHistory: vi.fn(),
    };
    storage = { inspectObject: vi.fn() };
    const messageEvents = createRealtimeMessageEvents();
    const messages = createMessagesService({
      repository: messageRepository,
      accessRepository,
      messageEvents,
      storage,
    });
    const roomCoordinator = createConversationRoomCoordinator();

    httpServer = createServer();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier,
      membershipRepository: accessRepository,
      roomCoordinator,
      messages,
      log,
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

  it('persists once, acknowledges the canonical message, and broadcasts once', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const receivedEvents = [];
    recipient.on('message:new', (event) => receivedEvents.push(event));

    const firstAcknowledgement = await sender.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: '  Canonical body  ',
    });

    expect(firstAcknowledgement).toEqual({
      ok: true,
      data: {
        created: true,
        message: serializeMessage(storedMessage),
      },
    });
    await waitFor(() => receivedEvents.length === 1);
    expect(receivedEvents[0]).toEqual({ message: serializeMessage(storedMessage) });
    expect(messageRepository.create).toHaveBeenLastCalledWith({
      conversationId,
      senderId,
      clientMessageId,
      body: 'Canonical body',
      replyToId: null,
    });

    const retryAcknowledgement = await sender.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'A retry cannot replace the canonical body',
    });

    expect(retryAcknowledgement).toEqual({
      ok: true,
      data: {
        created: false,
        message: serializeMessage(storedMessage),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedEvents).toHaveLength(1);
  });

  it('rechecks conversation membership for every event', async () => {
    const outsider = await connectClient('outsider-token');

    const acknowledgement = await outsider.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'Unauthorized body',
    });

    expect(acknowledgement).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Conversation not found',
      },
    });
    expect(messageRepository.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'socket_event_failed',
        socketEvent: 'message:send',
        userId: outsiderId,
        errorCode: 'NOT_FOUND',
      }),
      'Socket event rejected',
    );
  });

  it('acknowledges and broadcasts verified attachment metadata', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const receivedEvent = once(recipient, 'message:new');
    const storageKey = `conversations/${conversationId}/users/${senderId}/${randomUUID()}.png`;
    storage.inspectObject.mockResolvedValue({
      mimeType: 'image/png',
      size: 2048,
      metadata: {
        'conversation-id': conversationId,
        'uploader-id': senderId,
        'declared-size': '2048',
      },
    });

    const acknowledgement = await sender.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'Attached image',
      attachments: [{ storageKey, width: 640, height: 480 }],
    });

    expect(acknowledgement).toMatchObject({
      ok: true,
      data: {
        created: true,
        message: {
          body: 'Attached image',
          attachments: [
            {
              storageKey,
              mimeType: 'image/png',
              size: 2048,
              width: 640,
              height: 480,
              url: expect.stringMatching(/^\/attachments\/[0-9a-f-]+\/content$/u),
            },
          ],
        },
      },
    });
    await expect(receivedEvent).resolves.toEqual([{ message: acknowledgement.data.message }]);
  });

  it('returns validation details without reaching authorization', async () => {
    const sender = await connectClient('sender-token');

    const acknowledgement = await sender.timeout(1000).emitWithAck('message:send', {
      conversationId: 'not-a-uuid',
      clientMessageId,
      body: '   ',
      senderId: outsiderId,
    });

    expect(acknowledgement.ok).toBe(false);
    expect(acknowledgement.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Message validation failed',
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'conversationId' }),
        expect.objectContaining({ field: 'body' }),
      ]),
    });
    expect(accessRepository.findAccessContext).not.toHaveBeenCalled();
    expect(messageRepository.create).not.toHaveBeenCalled();
  });

  it('hides unexpected failures behind a generic acknowledgement', async () => {
    const sender = await connectClient('sender-token');
    const internalError = new Error('private database failure details');
    messageRepository.create.mockRejectedValueOnce(internalError);

    const acknowledgement = await sender.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'Hello',
    });

    expect(acknowledgement).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
    expect(JSON.stringify(acknowledgement)).not.toContain(internalError.message);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: internalError,
        event: 'socket_event_failed',
        socketEvent: 'message:send',
        userId: senderId,
      }),
      'Socket event failed',
    );
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
  return {
    ...message,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
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
