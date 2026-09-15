import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { closeRedisClient, connectRedisClient, createRedisClient } from '../../src/config/redis.js';

describe('Redis client configuration', () => {
  it('uses bounded timeouts, a disabled offline queue, and capped reconnect backoff', () => {
    const client = new EventEmitter();
    const clientFactory = vi.fn(() => client);

    createRedisClient({
      clientFactory,
      log: createLogger(),
      random: () => 0.99,
      url: 'rediss://user:secret@redis.example.com:6380',
      connectTimeoutMs: 1200,
      commandTimeoutMs: 800,
      reconnectMaxDelayMs: 500,
    });

    expect(clientFactory).toHaveBeenCalledWith({
      url: 'rediss://user:secret@redis.example.com:6380',
      disableOfflineQueue: true,
      commandOptions: { timeout: 800 },
      socket: {
        connectTimeout: 1200,
        reconnectStrategy: expect.any(Function),
      },
    });

    const { reconnectStrategy } = clientFactory.mock.calls[0][0].socket;
    expect(reconnectStrategy(0)).toBe(149);
    expect(reconnectStrategy(20)).toBe(500);
  });

  it('logs lifecycle failures without including the connection URL', () => {
    const client = new EventEmitter();
    const log = createLogger();
    const url = 'redis://user:secret@redis.example.com:6379';

    createRedisClient({ clientFactory: () => client, log, url });
    client.emit('error', new Error('connection refused'));
    client.emit('reconnecting');
    client.emit('ready');
    client.emit('end');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dependency: 'redis', status: 'unavailable' }),
      'Redis connection error',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis_reconnecting' }),
      'Redis reconnect scheduled',
    );
    const serializedLogCalls = JSON.stringify([
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    expect(serializedLogCalls).not.toContain(url);
    expect(serializedLogCalls).not.toContain('secret');
  });
});

describe('Redis client lifecycle', () => {
  it('connects a closed client and reuses an open client', async () => {
    const closedClient = { isOpen: false, connect: vi.fn().mockResolvedValue('connected') };
    const openClient = { isOpen: true, connect: vi.fn() };

    await expect(connectRedisClient(closedClient)).resolves.toBe('connected');
    await expect(connectRedisClient(openClient)).resolves.toBe(openClient);
    expect(closedClient.connect).toHaveBeenCalledOnce();
    expect(openClient.connect).not.toHaveBeenCalled();
  });

  it('closes only an open client', async () => {
    const openClient = { isOpen: true, close: vi.fn().mockResolvedValue() };
    const closedClient = { isOpen: false, close: vi.fn() };

    await closeRedisClient(openClient);
    await closeRedisClient(closedClient);

    expect(openClient.close).toHaveBeenCalledOnce();
    expect(closedClient.close).not.toHaveBeenCalled();
  });
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
