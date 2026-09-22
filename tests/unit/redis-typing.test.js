import { describe, expect, it, vi } from 'vitest';

import {
  createRedisTypingCoordinator,
  createRedisTypingStore,
} from '../../src/realtime/redis-typing.js';

const conversationId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';
const userId = '8ea637a5-67c5-481f-8073-e0a9264fc306';
const timestamp = Date.parse('2026-09-15T10:00:00.000Z');

describe('Redis typing store', () => {
  it('uses one Redis hash slot and maps shared start/stop state', async () => {
    const redisClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([timestamp + 5_000, timestamp + 5_500, 1])
        .mockResolvedValueOnce([0, 0, 1]),
    };
    const store = createRedisTypingStore(redisClient, {
      ttlMs: 5_000,
      broadcastIntervalMs: 1_000,
    });

    await expect(store.start({ conversationId, userId, socketId: 'socket-1' })).resolves.toEqual({
      expiresAt: timestamp + 5_000,
      aggregateExpiresAt: timestamp + 5_500,
      shouldBroadcast: true,
    });
    await expect(store.stop({ conversationId, userId, socketId: 'socket-1' })).resolves.toEqual({
      remaining: 0,
      aggregateExpiresAt: 0,
      transitionedStopped: true,
    });

    const startOptions = redisClient.eval.mock.calls[0][1];
    expect(startOptions.arguments).toEqual(['socket-1', '5000', '1000']);
    expect(startOptions.keys.every((key) => key.includes('{typing}'))).toBe(true);
  });
});

describe('Redis typing coordinator', () => {
  it('debounces shared starts and stops only after the final device', async () => {
    const redisClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([timestamp + 5_000, timestamp + 5_000, 1])
        .mockResolvedValueOnce([timestamp + 5_100, timestamp + 5_100, 0])
        .mockResolvedValueOnce([1, timestamp + 5_100, 0])
        .mockResolvedValueOnce([0, 0, 1]),
    };
    const room = { emit: vi.fn() };
    const coordinator = createRedisTypingCoordinator({
      redisClient,
      schedule: vi.fn().mockReturnValue({ unref: vi.fn() }),
      cancel: vi.fn(),
    });

    coordinator.attach({ to: vi.fn().mockReturnValue(room) });

    await expect(
      coordinator.start({ conversationId, userId, socketId: 'socket-1' }),
    ).resolves.toMatchObject({ isTyping: true });
    await coordinator.start({ conversationId, userId, socketId: 'socket-2' });
    expect(room.emit).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.stop({ conversationId, userId, socketId: 'socket-1' }),
    ).resolves.toMatchObject({ isTyping: true });
    expect(room.emit).toHaveBeenCalledTimes(1);

    await expect(coordinator.disconnectSocket('socket-2')).resolves.toBeUndefined();
    expect(room.emit).toHaveBeenLastCalledWith('typing:stop', {
      typing: { conversationId, userId, isTyping: false, expiresAt: null },
    });
  });
});
