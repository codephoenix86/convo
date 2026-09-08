import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../src/lib/errors.js';
import { getUserRoom } from '../../src/realtime/rooms.js';
import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const userId = '8ea637a5-67c5-481f-8073-e0a9264fc306';
const sessionId = '60c0ba6c-4752-4897-9f25-55a50e9b6da5';
const tokenId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';

describe('Socket.IO authentication and user rooms', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let tokenVerifier;
  let log;
  let clients;

  beforeEach(async () => {
    httpServer = createServer();
    tokenVerifier = vi.fn().mockResolvedValue({ userId, sessionId, tokenId });
    log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    clients = [];
    socketServer = createSocketServer(httpServer, {
      allowedOrigins: [CLIENT_ORIGIN],
      accessTokenVerifier: tokenVerifier,
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

    if (socketServer) {
      await new Promise((resolve) => socketServer.close(resolve));
    }
  });

  it('associates verified identity and joins the private user room', async () => {
    const client = createTestClient({ token: 'valid-access-token' });

    await connect(client);

    expect(tokenVerifier).toHaveBeenCalledOnce();
    expect(tokenVerifier).toHaveBeenCalledWith('valid-access-token');

    const serverSocket = socketServer.of('/').sockets.get(client.id);

    expect(serverSocket.data.user).toEqual({ id: userId, sessionId, tokenId });
    expect(serverSocket.rooms.has(getUserRoom(userId))).toBe(true);

    const accountEvent = new Promise((resolve) => client.once('account:test', resolve));
    socketServer.to(getUserRoom(userId)).emit('account:test', { available: true });

    await expect(accountEvent).resolves.toEqual({ available: true });
  });

  it('rejects missing and invalid credentials without exposing token material', async () => {
    const missingTokenClient = createTestClient();
    const missingTokenError = await connectExpectingError(missingTokenClient);

    expect(missingTokenError.message).toBe('Invalid or missing access token');
    expect(missingTokenError.data).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing access token',
    });
    expect(tokenVerifier).not.toHaveBeenCalled();

    const rejectedToken = 'rejected-access-token';
    tokenVerifier.mockRejectedValueOnce(new UnauthorizedError());
    const rejectedTokenClient = createTestClient({ token: rejectedToken });
    const rejectedTokenError = await connectExpectingError(rejectedTokenClient);

    expect(rejectedTokenError.data).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing access token',
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(rejectedToken);
    expect(socketServer.of('/').sockets.size).toBe(0);
  });

  it('tracks multiple connections without treating one disconnect as the user going offline', async () => {
    const firstClient = createTestClient({ token: 'first-access-token' });
    const secondClient = createTestClient({ token: 'second-access-token' });

    await connect(firstClient);
    await connect(secondClient);

    expect(latestLogFor('socket_connected')).toMatchObject({
      activeConnections: 2,
      activeUsers: 1,
      userConnections: 2,
    });

    firstClient.close();
    await waitFor(() => latestLogFor('socket_disconnected')?.activeConnections === 1);

    expect(latestLogFor('socket_disconnected')).toMatchObject({
      activeConnections: 1,
      activeUsers: 1,
      userConnections: 1,
    });

    secondClient.close();
    await waitFor(() => latestLogFor('socket_disconnected')?.activeConnections === 0);

    expect(latestLogFor('socket_disconnected')).toMatchObject({
      activeConnections: 0,
      activeUsers: 0,
      userConnections: 0,
    });
  });

  function createTestClient(auth = {}) {
    const client = createClient(serverUrl, {
      auth,
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });

    clients.push(client);

    return client;
  }

  function latestLogFor(event) {
    return log.info.mock.calls
      .map(([context]) => context)
      .filter((context) => context.event === event)
      .at(-1);
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
