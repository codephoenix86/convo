import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { io as createClient } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSocketServer } from '../../src/realtime/socket.js';

const CLIENT_ORIGIN = 'http://localhost:5173';
const firstUserId = randomUUID();
const secondUserId = randomUUID();
const outsiderId = randomUUID();
const conversationId = randomUUID();
const tokenUsers = new Map([
  ['first-token', firstUserId],
  ['second-token', secondUserId],
  ['second-device-token', secondUserId],
  ['outsider-token', outsiderId],
]);

describe('presence lifecycle', () => {
  let httpServer;
  let socketServer;
  let serverUrl;
  let clients;

  beforeEach(async () => {
    clients = [];
    const membershipRepository = {
      listConversationIdsForUser: vi.fn(async (userId) =>
        [firstUserId, secondUserId].includes(userId) ? [conversationId] : [],
      ),
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
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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

  it('sends an authorized online snapshot and server-derived update', async () => {
    const firstClient = createTestClient('first-token');
    const firstSnapshot = once(firstClient, 'presence:snapshot');

    await connect(firstClient);
    await expect(firstSnapshot).resolves.toEqual([{ items: [] }]);

    const onlineUpdate = once(firstClient, 'presence:update');
    const secondClient = createTestClient('second-token');
    const secondSnapshot = once(secondClient, 'presence:snapshot');

    await connect(secondClient);

    await expect(onlineUpdate).resolves.toEqual([
      {
        presence: {
          userId: secondUserId,
          isOnline: true,
          changedAt: expect.any(String),
        },
      },
    ]);
    await expect(secondSnapshot).resolves.toEqual([
      {
        items: [
          {
            userId: firstUserId,
            isOnline: true,
            changedAt: expect.any(String),
          },
        ],
      },
    ]);
  });

  it('does not expose presence outside shared authorized rooms', async () => {
    const outsider = createTestClient('outsider-token');
    const outsiderUpdates = [];
    outsider.on('presence:update', (event) => outsiderUpdates.push(event));
    const outsiderSnapshot = once(outsider, 'presence:snapshot');

    await connect(outsider);
    await expect(outsiderSnapshot).resolves.toEqual([{ items: [] }]);

    const firstClient = createTestClient('first-token');
    await connect(firstClient);
    outsider.emit('presence:update', {
      presence: { userId: firstUserId, isOnline: false },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outsiderUpdates).toEqual([]);
  });

  it('stays online until the final device disconnects', async () => {
    const firstClient = createTestClient('first-token');
    const updates = [];
    firstClient.on('presence:update', (event) => updates.push(event));
    await connect(firstClient);

    const firstDevice = createTestClient('second-token');
    const secondDevice = createTestClient('second-device-token');
    await connect(firstDevice);
    await waitFor(() => updates.length === 1);
    await connect(secondDevice);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates).toHaveLength(1);

    firstDevice.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updates).toHaveLength(1);

    secondDevice.close();
    await waitFor(() => updates.length === 2);
    expect(updates[1]).toEqual({
      presence: {
        userId: secondUserId,
        isOnline: false,
        changedAt: expect.any(String),
      },
    });
  });

  function createTestClient(token) {
    const client = createClient(serverUrl, {
      auth: { token },
      autoConnect: false,
      extraHeaders: { origin: CLIENT_ORIGIN },
      reconnection: false,
      transports: ['websocket'],
    });

    clients.push(client);

    return client;
  }
});

function connect(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
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
