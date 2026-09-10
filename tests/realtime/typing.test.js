import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTypingCoordinator } from '../../src/realtime/typing.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const firstUserId = randomUUID();
const secondUserId = randomUUID();
const outsiderId = randomUUID();
const conversationId = randomUUID();
const tokenUsers = new Map([
  ['first-token', firstUserId],
  ['second-token', secondUserId],
  ['outsider-token', outsiderId],
]);

describe('typing socket events', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;
  let membershipRepository;
  let log;

  beforeEach(async () => {
    clients = [];
    log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    membershipRepository = {
      listConversationIdsForUser: vi.fn(async (userId) =>
        [firstUserId, secondUserId].includes(userId) ? [conversationId] : [],
      ),
      findAccessContext: vi.fn().mockResolvedValue({
        id: conversationId,
        type: 'DIRECT',
        members: [
          { userId: firstUserId, role: 'MEMBER' },
          { userId: secondUserId, role: 'MEMBER' },
        ],
      }),
    };
    const accessTokenVerifier = vi.fn(async (token) => ({
      userId: tokenUsers.get(token),
      sessionId: randomUUID(),
      tokenId: randomUUID(),
    }));

    httpServer = createServer();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier,
      membershipRepository,
      typingCoordinator: createTypingCoordinator({ ttlMs: 500, broadcastIntervalMs: 100 }),
      typingRateLimit: { maxEvents: 3, windowMs: 2_000 },
      log,
    });

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

  it('acknowledges, broadcasts, debounces, and explicitly stops typing', async () => {
    const firstClient = await connectClient('first-token');
    const secondClient = await connectClient('second-token');
    const starts = [];
    const stops = [];
    secondClient.on('typing:start', (event) => starts.push(event));
    secondClient.on('typing:stop', (event) => stops.push(event));

    const firstAcknowledgement = await firstClient
      .timeout(1000)
      .emitWithAck('typing:start', { conversationId });

    expect(firstAcknowledgement).toMatchObject({
      ok: true,
      data: {
        typing: { conversationId, userId: firstUserId, isTyping: true },
      },
    });
    expect(firstAcknowledgement.data.typing.expiresAt).toEqual(expect.any(String));
    await waitFor(() => starts.length === 1);

    await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(starts).toHaveLength(1);

    const stopAcknowledgement = await firstClient
      .timeout(1000)
      .emitWithAck('typing:stop', { conversationId });

    expect(stopAcknowledgement).toEqual({
      ok: true,
      data: {
        typing: {
          conversationId,
          userId: firstUserId,
          isTyping: false,
          expiresAt: null,
        },
      },
    });
    await waitFor(() => stops.length === 1);
  });

  it('expires typing automatically when no stop arrives', async () => {
    const firstClient = await connectClient('first-token');
    const secondClient = await connectClient('second-token');
    const stopped = once(secondClient, 'typing:stop');

    await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });

    await expect(stopped).resolves.toEqual([
      {
        typing: {
          conversationId,
          userId: firstUserId,
          isTyping: false,
          expiresAt: null,
        },
      },
    ]);
  });

  it('rejects nonmembers and malformed payloads before state changes', async () => {
    const outsider = await connectClient('outsider-token');
    const unauthorized = await outsider
      .timeout(1000)
      .emitWithAck('typing:start', { conversationId });

    expect(unauthorized).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Conversation not found' },
    });

    const firstClient = await connectClient('first-token');
    membershipRepository.findAccessContext.mockClear();
    const invalid = await firstClient.timeout(1000).emitWithAck('typing:start', {
      conversationId: 'not-a-uuid',
      userId: firstUserId,
    });

    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Typing validation failed' },
    });
    expect(membershipRepository.findAccessContext).not.toHaveBeenCalled();
  });

  it('rate limits bursts before additional authorization queries', async () => {
    const firstClient = await connectClient('first-token');

    await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });
    await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });
    await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });
    const limited = await firstClient.timeout(1000).emitWithAck('typing:start', { conversationId });

    expect(limited).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Typing updates are too frequent' },
    });
    expect(membershipRepository.findAccessContext).toHaveBeenCalledTimes(3);
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
