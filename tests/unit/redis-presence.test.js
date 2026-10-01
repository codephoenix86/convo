import { describe, expect, it, vi } from 'vitest';

import {
  createRedisPresenceCoordinator,
  createRedisPresenceStore,
} from '../../src/realtime/redis-presence.js';
import { getConversationRoom, getUserRoom } from '../../src/realtime/rooms.js';

const firstUserId = '8ea637a5-67c5-481f-8073-e0a9264fc306';
const secondUserId = '60c0ba6c-4752-4897-9f25-55a50e9b6da5';
const hiddenUserId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';
const conversationId = '06aa708c-4dc8-4bb1-a994-8d6d906900da';
const timestamp = Date.parse('2026-09-15T10:00:00.000Z');

describe('Redis presence store', () => {
  it('maps atomic connection transitions and filters expired snapshot entries', async () => {
    const redisClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([2, 1, 2, String(timestamp), 1])
        .mockResolvedValueOnce([1, 1, 1, 0, timestamp + 5_000]),
      mGet: vi.fn().mockResolvedValue([String(timestamp), null]),
    };
    const store = createRedisPresenceStore(redisClient, { ttlMs: 30_000 });

    await expect(store.connect('socket-1', firstUserId)).resolves.toEqual({
      counts: { activeConnections: 2, activeUsers: 1, userConnections: 2 },
      onlineSince: '2026-09-15T10:00:00.000Z',
      transitionedOnline: true,
    });
    await expect(store.disconnect('socket-1', firstUserId)).resolves.toEqual({
      counts: { activeConnections: 1, activeUsers: 1, userConnections: 1 },
      transitionedOffline: false,
      changedAt: '2026-09-15T10:00:05.000Z',
    });
    await expect(store.getOnline([firstUserId, hiddenUserId])).resolves.toEqual([
      { userId: firstUserId, onlineSince: '2026-09-15T10:00:00.000Z' },
    ]);

    const connectCall = redisClient.eval.mock.calls[0];
    expect(connectCall[1].arguments).toEqual(['socket-1', firstUserId, '30000']);
    expect(connectCall[1].keys.every((key) => key.includes('{presence}'))).toBe(true);
  });
});

describe('Redis presence coordinator', () => {
  it('publishes first/last-device transitions and builds an authorized snapshot', async () => {
    const redisClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([1, 1, 1, String(timestamp), 1])
        .mockResolvedValueOnce([0, 0, 0, 1, timestamp + 5_000]),
      mGet: vi.fn().mockResolvedValue([String(timestamp), null]),
    };
    const membershipRepository = {
      listConversationIdsForUser: vi.fn().mockResolvedValue([conversationId]),
      listMemberIdsForConversations: vi
        .fn()
        .mockResolvedValue([firstUserId, secondUserId, hiddenUserId]),
    };
    const cancelHeartbeat = vi.fn();
    const coordinator = createRedisPresenceCoordinator({
      redisClient,
      membershipRepository,
      scheduleHeartbeat: vi.fn().mockReturnValue({ unref: vi.fn() }),
      cancelHeartbeat,
    });
    const socket = createSocket('socket-1', firstUserId);

    coordinator.attach({});
    await expect(coordinator.connectSocket(socket)).resolves.toEqual({
      activeConnections: 1,
      activeUsers: 1,
      userConnections: 1,
    });
    expect(socket.outbound.emit).toHaveBeenCalledWith('presence:update', {
      presence: {
        userId: firstUserId,
        isOnline: true,
        changedAt: '2026-09-15T10:00:00.000Z',
      },
    });

    await expect(coordinator.sendSnapshot(socket)).resolves.toEqual([
      {
        userId: secondUserId,
        isOnline: true,
        changedAt: '2026-09-15T10:00:00.000Z',
      },
    ]);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledWith(firstUserId);
    expect(membershipRepository.listMemberIdsForConversations).toHaveBeenCalledWith([
      conversationId,
    ]);

    await coordinator.disconnectSocket(socket);
    expect(cancelHeartbeat).toHaveBeenCalledOnce();
    expect(socket.outbound.emit).toHaveBeenLastCalledWith('presence:update', {
      presence: {
        userId: firstUserId,
        isOnline: false,
        changedAt: '2026-09-15T10:00:05.000Z',
      },
    });
  });

  it('refreshes snapshots for conversation members and directly affected users', async () => {
    const redisClient = {
      eval: vi.fn(),
      mGet: vi.fn().mockResolvedValue([String(timestamp)]),
    };
    const membershipRepository = {
      listConversationIdsForUser: vi.fn().mockResolvedValue([conversationId]),
      listMemberIdsForConversations: vi.fn().mockResolvedValue([firstUserId, secondUserId]),
    };
    const firstSocket = createSocket('socket-1', firstUserId, []);
    const secondSocket = createSocket('socket-2', secondUserId, []);
    const fetchSockets = vi.fn().mockResolvedValue([firstSocket, secondSocket]);
    const io = {
      in: vi.fn().mockReturnValue({ fetchSockets }),
    };
    const coordinator = createRedisPresenceCoordinator({
      redisClient,
      membershipRepository,
      scheduleHeartbeat: vi.fn(),
    });

    coordinator.attach(io);

    await expect(
      coordinator.refreshSnapshots({
        conversationId,
        userIds: [firstUserId, firstUserId],
      }),
    ).resolves.toBe(2);

    expect(io.in).toHaveBeenCalledWith([
      getConversationRoom(conversationId),
      getUserRoom(firstUserId),
    ]);
    expect(fetchSockets).toHaveBeenCalledOnce();
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledWith(firstUserId);
    expect(membershipRepository.listConversationIdsForUser).toHaveBeenCalledWith(secondUserId);
    expect(firstSocket.emit).toHaveBeenCalledWith('presence:snapshot', {
      items: [
        {
          userId: secondUserId,
          isOnline: true,
          changedAt: '2026-09-15T10:00:00.000Z',
        },
      ],
    });
    expect(secondSocket.emit).toHaveBeenCalledWith('presence:snapshot', {
      items: [
        {
          userId: firstUserId,
          isOnline: true,
          changedAt: '2026-09-15T10:00:00.000Z',
        },
      ],
    });
  });
});

function createSocket(id, userId, conversationIds = [conversationId]) {
  const outbound = { emit: vi.fn() };

  return {
    id,
    data: { user: { id: userId } },
    rooms: new Set([id, getUserRoom(userId), ...conversationIds.map(getConversationRoom)]),
    to: vi.fn().mockReturnValue(outbound),
    emit: vi.fn(),
    outbound,
  };
}
