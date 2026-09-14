import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createMessagesService } from '../../src/modules/messages/messages.service.js';
import { createConversationRoomCoordinator } from '../../src/realtime/conversation-rooms.js';
import { createRealtimeMessageEvents } from '../../src/realtime/message-events.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const senderId = randomUUID();
const recipientId = randomUUID();
const conversationId = randomUUID();
const clientMessageId = randomUUID();
const canonicalMessage = {
  id: randomUUID(),
  conversationId,
  senderId,
  clientMessageId,
  body: 'Canonical message',
  type: 'TEXT',
  replyToId: null,
  createdAt: new Date('2026-09-02T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T10:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  sender: { id: senderId, username: 'sender', avatarUrl: null },
};

describe('REST message realtime publication', () => {
  let httpServer;
  let socketServer;
  let recipientClient;
  let senderClient;
  let serverUrl;
  let messageRepository;

  beforeEach(async () => {
    const accessTokenVerifier = vi.fn(async (token) => ({
      userId: token === 'recipient-token' ? recipientId : senderId,
      sessionId: randomUUID(),
      tokenId: randomUUID(),
    }));
    const accessRepository = {
      findAccessContext: vi.fn().mockResolvedValue({
        id: conversationId,
        type: 'DIRECT',
        members: [{ userId: senderId, role: 'MEMBER' }],
      }),
      listConversationIdsForUser: vi.fn().mockResolvedValue([conversationId]),
    };
    messageRepository = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ message: canonicalMessage, created: true })
        .mockResolvedValue({ message: canonicalMessage, created: false }),
      listHistory: vi.fn(),
    };
    const messageEvents = createRealtimeMessageEvents();
    const messages = createMessagesService({
      repository: messageRepository,
      accessRepository,
      messageEvents,
    });
    const app = createApp({ messages, accessTokenVerifier });
    const roomCoordinator = createConversationRoomCoordinator();
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

    httpServer = createServer(app);
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
    recipientClient = createClient(serverUrl, {
      auth: { token: 'recipient-token' },
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });
    await once(recipientClient, 'connect');
    senderClient = createClient(serverUrl, {
      auth: { token: 'sender-token' },
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });
    await once(senderClient, 'connect');
  });

  afterEach(async () => {
    recipientClient.close();
    senderClient.close();
    await new Promise((resolve) => socketServer.close(resolve));
  });

  it('returns one canonical message across REST and socket retries without rebroadcasting', async () => {
    const receivedEvents = [];
    recipientClient.on('message:new', (event) => receivedEvents.push(event));

    const firstResponse = await sendMessage('  Canonical message  ');
    const firstBody = await firstResponse.json();

    expect(firstResponse.status).toBe(201);
    expect(firstBody.data.message).toEqual(serializeMessage(canonicalMessage));
    await waitFor(() => receivedEvents.length === 1);
    expect(receivedEvents[0]).toEqual({ message: serializeMessage(canonicalMessage) });

    const socketRetry = await senderClient.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'A socket retry cannot replace the canonical body',
    });
    expect(socketRetry).toEqual({
      ok: true,
      data: { message: serializeMessage(canonicalMessage), created: false },
    });

    const retryResponse = await sendMessage('A retry cannot replace the canonical body');
    const retryBody = await retryResponse.json();

    expect(retryResponse.status).toBe(200);
    expect(retryBody.data.message).toEqual(firstBody.data.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedEvents).toHaveLength(1);
    expect(messageRepository.create).toHaveBeenCalledTimes(3);
  });

  function sendMessage(body) {
    return fetch(`${serverUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sender-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ clientMessageId, body }),
    });
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
