import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../src/lib/errors.js';
import { getConversationRoom, getUserRoom } from '../../src/realtime/rooms.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const userId = randomUUID();
const sessionId = randomUUID();
const tokenId = randomUUID();
const firstConversationId = randomUUID();
const secondConversationId = randomUUID();

describe('Socket.IO reconnect recovery', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let client;
  let accessTokenVerifier;
  let membershipRepository;
  let currentConversationIds;

  beforeEach(async () => {
    currentConversationIds = [firstConversationId];
    accessTokenVerifier = vi.fn(async (token) => {
      if (token === 'expired-access-token') {
        throw new UnauthorizedError();
      }

      return { userId, sessionId, tokenId };
    });
    membershipRepository = {
      listConversationIdsForUser: vi.fn(async () => currentConversationIds),
    };
    httpServer = createServer();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier,
      membershipRepository,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');

    const address = httpServer.address();
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    client?.close();

    if (socketServer) {
      await new Promise((resolve) => socketServer.close(resolve));
    }
  });

  it('re-authenticates, rebuilds current rooms, and resumes authorized delivery', async () => {
    client = createReconnectableClient('initial-access-token');
    const firstReady = waitForEvent(client, 'session:ready');

    client.connect();
    await once(client, 'connect');

    const [firstSession] = await firstReady;
    const firstConnectionId = client.id;
    expectReadySession(firstSession, firstConnectionId);
    expectServerRooms(firstConnectionId, {
      includedConversationId: firstConversationId,
      excludedConversationId: secondConversationId,
    });

    currentConversationIds = [secondConversationId];
    client.auth.token = 'refreshed-access-token';
    const disconnected = waitForEvent(client, 'disconnect');
    const reconnected = waitForEvent(client, 'connect');
    const secondReady = waitForEvent(client, 'session:ready');

    client.io.engine.close();
    await disconnected;
    await reconnected;

    const [secondSession] = await secondReady;
    const secondConnectionId = client.id;
    expect(secondConnectionId).not.toBe(firstConnectionId);
    expectReadySession(secondSession, secondConnectionId);
    expect(accessTokenVerifier.mock.calls.map(([token]) => token)).toEqual([
      'initial-access-token',
      'refreshed-access-token',
    ]);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledTimes(2);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenNthCalledWith(1, userId);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenNthCalledWith(2, userId);
    expectServerRooms(secondConnectionId, {
      includedConversationId: secondConversationId,
      excludedConversationId: firstConversationId,
    });

    const receivedMessages = [];
    client.on('message:new', (event) => receivedMessages.push(event));
    socketServer.to(getConversationRoom(firstConversationId)).emit('message:new', {
      message: { id: 'stale-room-message' },
    });
    socketServer.to(getConversationRoom(secondConversationId)).emit('message:new', {
      message: { id: 'current-room-message' },
    });

    await waitFor(() => receivedMessages.length === 1);
    expect(receivedMessages).toEqual([{ message: { id: 'current-room-message' } }]);
  });

  it('rejects a reconnect when the refreshed handshake token is invalid', async () => {
    client = createReconnectableClient('initial-access-token');
    const firstReady = waitForEvent(client, 'session:ready');

    client.connect();
    await once(client, 'connect');
    await firstReady;

    client.auth.token = 'expired-access-token';
    const reconnectError = waitForEvent(client, 'connect_error');
    client.io.engine.close();

    const [error] = await reconnectError;
    expect(error.data).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing access token',
    });
    expect(accessTokenVerifier.mock.calls.map(([token]) => token)).toEqual([
      'initial-access-token',
      'expired-access-token',
    ]);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledOnce();
    expect(socketServer.of('/').sockets.size).toBe(0);
  });

  function createReconnectableClient(token) {
    return createClient(serverUrl, {
      auth: { token },
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: true,
      reconnectionDelay: 10,
      reconnectionDelayMax: 10,
      randomizationFactor: 0,
      transports: ['websocket'],
    });
  }

  function expectReadySession(session, connectionId) {
    expect(session).toEqual({
      connectionId,
      serverTime: expect.any(String),
      syncRequired: true,
    });
    expect(Number.isNaN(Date.parse(session.serverTime))).toBe(false);
  }

  function expectServerRooms(connectionId, { includedConversationId, excludedConversationId }) {
    const serverSocket = socketServer.of('/').sockets.get(connectionId);

    expect(serverSocket.rooms.has(getUserRoom(userId))).toBe(true);
    expect(serverSocket.rooms.has(getConversationRoom(includedConversationId))).toBe(true);
    expect(serverSocket.rooms.has(getConversationRoom(excludedConversationId))).toBe(false);
  }
});

function waitForEvent(emitter, event) {
  return once(emitter, event);
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
