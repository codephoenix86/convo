import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessagesService } from '../../src/modules/messages/messages.service.js';
import { createConversationRoomCoordinator } from '../../src/realtime/conversation-rooms.js';
import { createRealtimeMessageEvents } from '../../src/realtime/message-events.js';
import { createSocketServer } from '../../src/realtime/socket.js';
import { createTypingCoordinator } from '../../src/realtime/typing.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const aliceId = randomUUID();
const bobId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const attachmentId = randomUUID();
const clientMessageId = randomUUID();
const storageKey = `conversations/${conversationId}/users/${aliceId}/${randomUUID()}.png`;
const createdAt = new Date('2026-09-10T15:00:00.000Z');
const tokenUsers = new Map([
  ['alice-token', aliceId],
  ['bob-token', bobId],
]);

describe('Realtime messaging lifecycle acceptance', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;
  let storedMessage;

  beforeEach(async () => {
    clients = [];
    storedMessage = null;
    const accessRepository = createAccessRepository();
    const repository = createMessageRepository();
    const messageEvents = createRealtimeMessageEvents();
    const messages = createMessagesService({
      repository,
      accessRepository,
      messageEvents,
      storage: {
        inspectObject: vi.fn().mockResolvedValue({
          mimeType: 'image/png',
          size: 2048,
          metadata: {
            'conversation-id': conversationId,
            'uploader-id': aliceId,
            'declared-size': '2048',
          },
        }),
      },
    });

    httpServer = createServer();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier: vi.fn(async (token) => ({
        userId: tokenUsers.get(token),
        sessionId: randomUUID(),
        tokenId: randomUUID(),
      })),
      membershipRepository: accessRepository,
      roomCoordinator: createConversationRoomCoordinator(),
      typingCoordinator: createTypingCoordinator({ ttlMs: 500, broadcastIntervalMs: 100 }),
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

  it('composes presence, typing, attachments, receipts, edits, and deletion', async () => {
    const bobConnection = await connectClient('bob-token');
    expect(bobConnection.snapshot).toEqual({ items: [] });

    const aliceOnline = once(bobConnection.client, 'presence:update');
    const aliceConnection = await connectClient('alice-token');
    await expect(aliceOnline).resolves.toEqual([
      {
        presence: {
          userId: aliceId,
          isOnline: true,
          changedAt: expect.any(String),
        },
      },
    ]);
    expect(aliceConnection.snapshot.items).toEqual([
      expect.objectContaining({ userId: bobId, isOnline: true }),
    ]);

    const typingStarted = once(bobConnection.client, 'typing:start');
    const startAck = await aliceConnection.client
      .timeout(1000)
      .emitWithAck('typing:start', { conversationId });
    expect(startAck).toMatchObject({
      ok: true,
      data: { typing: { conversationId, userId: aliceId, isTyping: true } },
    });
    await expect(typingStarted).resolves.toEqual([{ typing: startAck.data.typing }]);

    const typingStopped = once(bobConnection.client, 'typing:stop');
    await aliceConnection.client.timeout(1000).emitWithAck('typing:stop', { conversationId });
    await expect(typingStopped).resolves.toEqual([
      {
        typing: {
          conversationId,
          userId: aliceId,
          isTyping: false,
          expiresAt: null,
        },
      },
    ]);

    const newMessage = once(bobConnection.client, 'message:new');
    const sendAck = await aliceConnection.client.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId,
      body: 'Milestone D image',
      attachments: [{ storageKey, width: 640, height: 480 }],
    });
    expect(sendAck).toMatchObject({
      ok: true,
      data: {
        created: true,
        message: {
          id: messageId,
          body: 'Milestone D image',
          attachments: [
            {
              id: attachmentId,
              storageKey,
              mimeType: 'image/png',
              size: 2048,
              width: 640,
              height: 480,
              url: `/attachments/${attachmentId}/content`,
            },
          ],
        },
      },
    });
    await expect(newMessage).resolves.toEqual([{ message: sendAck.data.message }]);

    const unauthorizedEdit = await bobConnection.client.timeout(1000).emitWithAck('message:edit', {
      messageId,
      body: 'Recipient edit',
    });
    expect(unauthorizedEdit).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Only the message sender can modify it' },
    });

    const deliveredEvent = once(aliceConnection.client, 'message:delivered');
    const deliveredAck = await bobConnection.client
      .timeout(1000)
      .emitWithAck('message:delivered', { conversationId, messageId });
    expect(deliveredAck).toMatchObject({
      ok: true,
      data: { receipt: { userId: bobId, lastDeliveredMessageId: messageId } },
    });
    await expect(deliveredEvent).resolves.toEqual([{ receipt: deliveredAck.data.receipt }]);

    const readEvent = once(aliceConnection.client, 'conversation:read');
    const readAck = await bobConnection.client
      .timeout(1000)
      .emitWithAck('conversation:read', { conversationId, messageId });
    expect(readAck).toMatchObject({
      ok: true,
      data: { receipt: { userId: bobId, lastReadMessageId: messageId } },
    });
    await expect(readEvent).resolves.toEqual([{ receipt: readAck.data.receipt }]);

    const editedEvent = once(bobConnection.client, 'message:edited');
    const editAck = await aliceConnection.client.timeout(1000).emitWithAck('message:edit', {
      messageId,
      body: 'Edited Milestone D image',
    });
    expect(editAck).toMatchObject({
      ok: true,
      data: { message: { id: messageId, body: 'Edited Milestone D image' } },
    });
    await expect(editedEvent).resolves.toEqual([{ message: editAck.data.message }]);

    const deletedEvent = once(bobConnection.client, 'message:deleted');
    const deleteAck = await aliceConnection.client
      .timeout(1000)
      .emitWithAck('message:delete', { messageId });
    expect(deleteAck).toMatchObject({
      ok: true,
      data: {
        message: {
          id: messageId,
          body: null,
          attachments: [],
          deletedAt: expect.any(String),
        },
      },
    });
    await expect(deletedEvent).resolves.toEqual([{ message: deleteAck.data.message }]);

    const aliceOffline = once(bobConnection.client, 'presence:update');
    aliceConnection.client.close();
    await expect(aliceOffline).resolves.toEqual([
      {
        presence: {
          userId: aliceId,
          isOnline: false,
          changedAt: expect.any(String),
        },
      },
    ]);
  });

  function createAccessRepository() {
    return {
      listConversationIdsForUser: vi.fn().mockResolvedValue([conversationId]),
      findAccessContext: vi.fn().mockResolvedValue({
        id: conversationId,
        type: 'DIRECT',
        members: [
          { userId: aliceId, role: 'MEMBER' },
          { userId: bobId, role: 'MEMBER' },
        ],
      }),
    };
  }

  function createMessageRepository() {
    return {
      create: vi.fn(async (input) => {
        storedMessage = {
          id: messageId,
          conversationId,
          senderId: aliceId,
          clientMessageId,
          body: input.body,
          type: 'TEXT',
          replyToId: null,
          createdAt,
          updatedAt: createdAt,
          editedAt: null,
          deletedAt: null,
          sender: { id: aliceId, username: 'alice', avatarUrl: null },
          attachments: [
            {
              id: attachmentId,
              ...input.attachments[0],
              createdAt,
            },
          ],
        };

        return { message: storedMessage, created: true };
      }),
      listHistory: vi.fn(),
      findMutationContext: vi.fn(async () => storedMessage),
      edit: vi.fn(async ({ body }) => {
        const editedAt = new Date('2026-09-10T15:01:00.000Z');
        storedMessage = { ...storedMessage, body, editedAt, updatedAt: editedAt };

        return storedMessage;
      }),
      softDelete: vi.fn(async () => {
        const deletedAt = new Date('2026-09-10T15:02:00.000Z');
        storedMessage = { ...storedMessage, deletedAt, updatedAt: deletedAt };

        return storedMessage;
      }),
      advanceDeliveredPosition: vi.fn(async ({ userId }) => ({
        advanced: true,
        receipt: {
          conversationId,
          userId,
          lastDeliveredMessageId: messageId,
          lastDeliveredAt: createdAt,
        },
      })),
      advanceReadPosition: vi.fn(async ({ userId }) => ({
        advanced: true,
        receipt: {
          conversationId,
          userId,
          lastReadMessageId: messageId,
          lastReadAt: createdAt,
        },
      })),
    };
  }

  async function connectClient(token) {
    const client = createClient(serverUrl, {
      auth: { token },
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });
    const connected = once(client, 'connect');
    const ready = once(client, 'session:ready');
    const snapshot = once(client, 'presence:snapshot');

    clients.push(client);
    client.connect();
    await connected;
    await ready;
    const [presenceSnapshot] = await snapshot;

    return { client, snapshot: presenceSnapshot };
  }
});
