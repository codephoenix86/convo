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
const receiptTimestamp = new Date('2026-09-10T10:00:00.000Z');
const tokenUsers = new Map([
  ['sender-token', senderId],
  ['recipient-token', recipientId],
  ['outsider-token', outsiderId],
]);

describe('delivery and read receipts', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;
  let messageRepository;
  let accessRepository;
  let log;

  beforeEach(async () => {
    clients = [];
    log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const advancedReceipts = new Set();
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
      create: vi.fn(),
      listHistory: vi.fn(),
      advanceDeliveredPosition: vi.fn(async ({ userId }) =>
        createReceiptResult('delivered', userId, advancedReceipts),
      ),
      advanceReadPosition: vi.fn(async ({ userId }) =>
        createReceiptResult('read', userId, advancedReceipts),
      ),
    };
    const messageEvents = createRealtimeMessageEvents();
    const messages = createMessagesService({
      repository: messageRepository,
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

  it('acknowledges and broadcasts a durable delivery position once', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const receivedEvents = [];
    sender.on('message:delivered', (event) => receivedEvents.push(event));

    const firstAcknowledgement = await recipient
      .timeout(1000)
      .emitWithAck('message:delivered', { conversationId, messageId });

    expect(firstAcknowledgement).toEqual({
      ok: true,
      data: { receipt: serializedDeliveryReceipt(recipientId) },
    });
    await waitFor(() => receivedEvents.length === 1);
    expect(receivedEvents).toEqual([{ receipt: serializedDeliveryReceipt(recipientId) }]);
    expect(messageRepository.advanceDeliveredPosition).toHaveBeenCalledWith({
      conversationId,
      userId: recipientId,
      messageId,
    });

    const retryAcknowledgement = await recipient
      .timeout(1000)
      .emitWithAck('message:delivered', { conversationId, messageId });

    expect(retryAcknowledgement).toEqual(firstAcknowledgement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedEvents).toHaveLength(1);
  });

  it('acknowledges and broadcasts a durable read position', async () => {
    const sender = await connectClient('sender-token');
    const recipient = await connectClient('recipient-token');
    const receivedEvent = once(sender, 'conversation:read');

    const acknowledgement = await recipient
      .timeout(1000)
      .emitWithAck('conversation:read', { conversationId, messageId });

    expect(acknowledgement).toEqual({
      ok: true,
      data: { receipt: serializedReadReceipt(recipientId) },
    });
    await expect(receivedEvent).resolves.toEqual([{ receipt: serializedReadReceipt(recipientId) }]);
    expect(messageRepository.advanceReadPosition).toHaveBeenCalledWith({
      conversationId,
      userId: recipientId,
      messageId,
    });
  });

  it.each(['message:delivered', 'conversation:read'])(
    'rejects unauthorized %s events before persistence',
    async (eventName) => {
      const outsider = await connectClient('outsider-token');

      const acknowledgement = await outsider
        .timeout(1000)
        .emitWithAck(eventName, { conversationId, messageId });

      expect(acknowledgement).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Conversation not found' },
      });
      expect(messageRepository.advanceDeliveredPosition).not.toHaveBeenCalled();
      expect(messageRepository.advanceReadPosition).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'socket_event_failed',
          socketEvent: eventName,
          userId: outsiderId,
          errorCode: 'NOT_FOUND',
        }),
        'Socket event rejected',
      );
    },
  );

  it('rejects malformed receipt payloads before authorization', async () => {
    const recipient = await connectClient('recipient-token');

    const acknowledgement = await recipient.timeout(1000).emitWithAck('message:delivered', {
      conversationId: 'not-a-uuid',
      messageId,
      userId: recipientId,
    });

    expect(acknowledgement.ok).toBe(false);
    expect(acknowledgement.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Delivery receipt validation failed',
      details: expect.arrayContaining([expect.objectContaining({ field: 'conversationId' })]),
    });
    expect(accessRepository.findAccessContext).not.toHaveBeenCalled();
    expect(messageRepository.advanceDeliveredPosition).not.toHaveBeenCalled();
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

function createReceiptResult(type, userId, advancedReceipts) {
  const key = `${type}:${userId}:${messageId}`;
  const advanced = !advancedReceipts.has(key);

  advancedReceipts.add(key);

  return {
    receipt:
      type === 'delivered'
        ? {
            conversationId,
            userId,
            lastDeliveredMessageId: messageId,
            lastDeliveredAt: receiptTimestamp,
          }
        : {
            conversationId,
            userId,
            lastReadMessageId: messageId,
            lastReadAt: receiptTimestamp,
          },
    advanced,
  };
}

function serializedDeliveryReceipt(userId) {
  return {
    conversationId,
    userId,
    lastDeliveredMessageId: messageId,
    lastDeliveredAt: receiptTimestamp.toISOString(),
  };
}

function serializedReadReceipt(userId) {
  return {
    conversationId,
    userId,
    lastReadMessageId: messageId,
    lastReadAt: receiptTimestamp.toISOString(),
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
