import { describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../../src/lib/errors.js';
import { createTypingRateLimiter } from '../../src/realtime/handlers/typing.js';
import { createTypingCoordinator } from '../../src/realtime/typing.js';

const conversationId = 'e353c8ab-ab4b-4c25-9ce7-270de287c4ce';
const userId = '8ea637a5-67c5-481f-8073-e0a9264fc306';

describe('typing coordinator', () => {
  it('debounces refresh broadcasts while extending socket expiry', () => {
    let currentTime = Date.parse('2026-09-10T10:00:00.000Z');
    const { coordinator, room } = createFixture({ now: () => currentTime });

    const first = coordinator.start({ conversationId, userId, socketId: 'socket-1' });
    currentTime += 500;
    const refreshed = coordinator.start({ conversationId, userId, socketId: 'socket-1' });

    expect(first).toEqual({
      conversationId,
      userId,
      isTyping: true,
      expiresAt: '2026-09-10T10:00:05.000Z',
    });
    expect(refreshed.expiresAt).toBe('2026-09-10T10:00:05.500Z');
    expect(room.emit).toHaveBeenCalledOnce();

    currentTime += 500;
    coordinator.start({ conversationId, userId, socketId: 'socket-1' });

    expect(room.emit).toHaveBeenCalledTimes(2);
    expect(room.emit).toHaveBeenLastCalledWith(
      'typing:start',
      expect.objectContaining({
        typing: expect.objectContaining({ isTyping: true, expiresAt: '2026-09-10T10:00:06.000Z' }),
      }),
    );
  });

  it('stays active until the final user socket stops', () => {
    const { coordinator, room } = createFixture();

    coordinator.start({ conversationId, userId, socketId: 'socket-1' });
    coordinator.start({ conversationId, userId, socketId: 'socket-2' });
    room.emit.mockClear();

    expect(coordinator.stop({ conversationId, userId, socketId: 'socket-1' })).toMatchObject({
      isTyping: true,
    });
    expect(room.emit).not.toHaveBeenCalled();

    coordinator.disconnectSocket('socket-2');

    expect(room.emit).toHaveBeenCalledWith('typing:stop', {
      typing: { conversationId, userId, isTyping: false, expiresAt: null },
    });
  });

  it('expires stale typing state automatically', () => {
    let expiryCallback;
    const { coordinator, room } = createFixture({
      schedule: (callback) => {
        expiryCallback = callback;
        return { unref: vi.fn() };
      },
    });

    coordinator.start({ conversationId, userId, socketId: 'socket-1' });
    room.emit.mockClear();
    expiryCallback();

    expect(room.emit).toHaveBeenCalledWith('typing:stop', {
      typing: { conversationId, userId, isTyping: false, expiresAt: null },
    });
  });

  it('fails fast before being attached to a Socket.IO server', () => {
    const coordinator = createTypingCoordinator();

    expect(() => coordinator.start({ conversationId, userId, socketId: 'socket-1' })).toThrow(
      'Typing coordinator is not attached',
    );
  });
});

describe('typing rate limiter', () => {
  it('caps bursts and resets after its fixed window', () => {
    let currentTime = 1_000;
    const limiter = createTypingRateLimiter({
      maxEvents: 2,
      windowMs: 1_000,
      now: () => currentTime,
    });

    limiter.consume();
    limiter.consume();
    expect(() => limiter.consume()).toThrow(RateLimitError);

    currentTime += 1_000;
    expect(() => limiter.consume()).not.toThrow();
  });
});

function createFixture(overrides = {}) {
  const room = { emit: vi.fn() };
  const io = { to: vi.fn().mockReturnValue(room) };
  const coordinator = createTypingCoordinator({
    schedule: () => ({ unref: vi.fn() }),
    cancel: vi.fn(),
    ...overrides,
  });

  coordinator.attach(io);
  expect(io.to).toHaveBeenCalledTimes(0);

  return { coordinator, io, room };
}
