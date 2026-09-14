import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { createApplicationRateLimiters } from '../../src/config/rate-limits.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const userId = randomUUID();
const conversationId = randomUUID();
const clientMessageId = randomUUID();

describe('message send rate limit across transports', () => {
  let httpServer;
  let socketServer;
  let client;
  let serverUrl;
  let messages;

  beforeEach(async () => {
    const accessTokenVerifier = vi.fn().mockResolvedValue({
      userId,
      sessionId: randomUUID(),
      tokenId: randomUUID(),
    });
    const membershipRepository = {
      listConversationIdsForUser: vi.fn().mockResolvedValue([conversationId]),
    };
    const rateLimiters = createApplicationRateLimiters({
      policies: { messageSend: { limit: 2, windowMs: 60_000 } },
    });
    messages = {
      send: vi.fn(async (_userId, input) => ({
        created: true,
        message: {
          id: randomUUID(),
          conversationId,
          senderId: userId,
          clientMessageId: input.clientMessageId,
          body: input.body,
        },
      })),
    };
    const app = createApp({ messages, accessTokenVerifier, rateLimiters });

    httpServer = createServer(app);
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier,
      membershipRepository,
      messageSendRateLimiter: rateLimiters.messageSend,
      messages,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const address = httpServer.address();
    serverUrl = `http://127.0.0.1:${address.port}`;
    client = createClient(serverUrl, {
      auth: { token: 'valid-access-token' },
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });
    await once(client, 'connect');
  });

  afterEach(async () => {
    client.close();
    await new Promise((resolve) => socketServer.close(resolve));
  });

  it('cannot bypass one per-user budget by switching between REST and Socket.IO', async () => {
    const restResponse = await fetch(`${serverUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-access-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ clientMessageId, body: 'REST message' }),
    });
    expect(restResponse.status).toBe(201);

    const socketResponse = await client.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId: randomUUID(),
      body: 'Socket message',
    });
    expect(socketResponse.ok).toBe(true);

    const limitedSocketResponse = await client.timeout(1000).emitWithAck('message:send', {
      conversationId,
      clientMessageId: randomUUID(),
      body: 'Blocked socket message',
    });
    expect(limitedSocketResponse).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Message sends are too frequent' },
    });

    const limitedRestResponse = await fetch(
      `${serverUrl}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ clientMessageId: randomUUID(), body: 'Blocked REST message' }),
      },
    );

    expect(limitedRestResponse.status).toBe(429);
    expect(limitedRestResponse.headers.get('retry-after')).toBe('60');
    await expect(limitedRestResponse.json()).resolves.toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'Message sends are too frequent' },
    });
    expect(messages.send).toHaveBeenCalledTimes(2);
  });
});
