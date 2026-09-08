import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConversationRoomCoordinator } from '../../src/realtime/conversation-rooms.js';
import { getConversationRoom, getUserRoom } from '../../src/realtime/rooms.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const firstUserId = '8ea637a5-67c5-481f-8073-e0a9264fc306';
const secondUserId = '60c0ba6c-4752-4897-9f25-55a50e9b6da5';
const firstConversationId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';
const secondConversationId = '06aa708c-4dc8-4bb1-a994-8d6d906900da';
const guessedConversationId = '293a7acd-6d93-4a38-a18a-dad599903e23';

describe('Socket.IO conversation rooms', () => {
  let httpServer;
  let socketServer;
  let roomCoordinator;
  let membershipRepository;
  let tokenVerifier;
  let log;
  let serverUrl;
  let clients;

  beforeEach(async () => {
    httpServer = createServer();
    membershipRepository = {
      listConversationIdsForUser: vi.fn().mockResolvedValue([]),
    };
    tokenVerifier = vi.fn(async (token) => ({
      userId: token.startsWith('second') ? secondUserId : firstUserId,
      sessionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      tokenId: '00a10a13-2997-4673-9f62-3de9d3894121',
    }));
    log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    clients = [];
    roomCoordinator = createConversationRoomCoordinator();
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier: tokenVerifier,
      membershipRepository,
      roomCoordinator,
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

  it('derives initial conversation rooms exclusively from persisted memberships', async () => {
    membershipRepository.listConversationIdsForUser.mockResolvedValue([
      firstConversationId,
      secondConversationId,
    ]);
    const client = createTestClient('first-token', {
      conversationIds: [guessedConversationId],
    });

    await connect(client);

    const serverSocket = socketServer.of('/').sockets.get(client.id);

    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledWith(firstUserId);
    expect(serverSocket.rooms).toEqual(
      new Set([
        client.id,
        getUserRoom(firstUserId),
        getConversationRoom(firstConversationId),
        getConversationRoom(secondConversationId),
      ]),
    );
    expect(serverSocket.rooms.has(getConversationRoom(guessedConversationId))).toBe(false);
  });

  it('rejects the connection safely when memberships cannot be loaded', async () => {
    membershipRepository.listConversationIdsForUser.mockRejectedValue(
      new Error('database credentials must stay private'),
    );
    const client = createTestClient('first-token');

    const connectionError = await connectExpectingError(client);

    expect(connectionError.data).toEqual({
      code: 'CONNECTION_UNAVAILABLE',
      message: 'Unable to establish socket connection',
    });
    expect(connectionError.message).not.toContain('database');
    expect(socketServer.of('/').sockets.size).toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'socket_membership_load_failed',
        userId: firstUserId,
      }),
      'Socket conversation memberships could not be loaded',
    );
  });

  it('joins and removes every active device when membership changes', async () => {
    membershipRepository.listConversationIdsForUser.mockImplementation(async (userId) =>
      userId === secondUserId ? [firstConversationId] : [],
    );
    const firstDevice = createTestClient('first-device-token');
    const secondDevice = createTestClient('first-second-device-token');
    const existingMember = createTestClient('second-device-token');

    await Promise.all([connect(firstDevice), connect(secondDevice), connect(existingMember)]);

    await roomCoordinator.membersAdded({
      conversationId: firstConversationId,
      userIds: [firstUserId],
    });

    await waitFor(() => roomMembers(firstConversationId)?.size === 3);
    expect(roomMembers(firstConversationId)).toEqual(
      new Set([firstDevice.id, secondDevice.id, existingMember.id]),
    );

    await roomCoordinator.memberRemoved({
      conversationId: firstConversationId,
      userId: firstUserId,
    });

    await waitFor(() => roomMembers(firstConversationId)?.size === 1);
    expect(roomMembers(firstConversationId)).toEqual(new Set([existingMember.id]));
  });

  it('serializes a concurrent removal behind room initialization', async () => {
    const membershipResult = createDeferred();
    membershipRepository.listConversationIdsForUser.mockReturnValue(membershipResult.promise);
    const client = createTestClient('first-token');

    const connection = connect(client);
    await waitFor(() => membershipRepository.listConversationIdsForUser.mock.calls.length === 1);

    const removal = roomCoordinator.memberRemoved({
      conversationId: firstConversationId,
      userId: firstUserId,
    });
    membershipResult.resolve([firstConversationId]);

    await Promise.all([connection, removal]);

    const serverSocket = socketServer.of('/').sockets.get(client.id);
    expect(serverSocket.rooms.has(getUserRoom(firstUserId))).toBe(true);
    expect(serverSocket.rooms.has(getConversationRoom(firstConversationId))).toBe(false);
  });

  function createTestClient(token, additionalAuth = {}) {
    const client = createClient(serverUrl, {
      auth: { token, ...additionalAuth },
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });

    clients.push(client);

    return client;
  }

  function roomMembers(conversationId) {
    return socketServer.of('/').adapter.rooms.get(getConversationRoom(conversationId));
  }
});

function connect(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
}

function connectExpectingError(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', () => reject(new Error('Expected the connection to be rejected')));
    client.once('connect_error', resolve);
    client.connect();
  });
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}
