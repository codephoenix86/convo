import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createSocketAdapterReadinessMiddleware,
  createSocketRedisAdapter,
} from '../../src/realtime/socket-redis-adapter.js';

describe('Socket.IO Redis adapter lifecycle', () => {
  it('connects dedicated clients, installs the sharded adapter, and tracks availability', async () => {
    const publisher = createRedisClientDouble();
    const subscriber = createRedisClientDouble();
    const redisClient = {
      duplicate: vi.fn().mockReturnValueOnce(publisher).mockReturnValueOnce(subscriber),
    };
    const adapterConstructor = vi.fn();
    const adapterFactory = vi.fn().mockReturnValue(adapterConstructor);
    const io = {
      adapter: vi.fn(),
      local: { disconnectSockets: vi.fn() },
    };
    const log = createLogger();
    const lifecycle = createSocketRedisAdapter({
      redisClient,
      adapterFactory,
      channelPrefix: 'convo:test',
      log,
    });

    lifecycle.attach(io);
    await lifecycle.connect();

    expect(redisClient.duplicate).toHaveBeenCalledTimes(2);
    expect(publisher.connect).toHaveBeenCalledOnce();
    expect(subscriber.connect).toHaveBeenCalledOnce();
    expect(adapterFactory).toHaveBeenCalledWith(publisher, subscriber, {
      channelPrefix: 'convo:test',
      subscriptionMode: 'dynamic',
    });
    expect(io.adapter).toHaveBeenCalledWith(adapterConstructor);
    expect(lifecycle.isReady()).toBe(true);

    publisher.isReady = false;
    publisher.emit('reconnecting');
    expect(lifecycle.isReady()).toBe(false);
    expect(io.local.disconnectSockets).toHaveBeenCalledWith(true);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'socket_adapter_unavailable' }),
      'Socket.IO Redis adapter is unavailable',
    );

    publisher.isReady = true;
    publisher.emit('ready');
    expect(lifecycle.isReady()).toBe(true);

    await lifecycle.close();
    expect(subscriber.close).toHaveBeenCalledOnce();
    expect(publisher.close).toHaveBeenCalledOnce();
    expect(lifecycle.isReady()).toBe(false);
  });

  it('requires attachment before connection and rejects duplicate attachment', async () => {
    const lifecycle = createSocketRedisAdapter({
      redisClient: {
        duplicate: vi
          .fn()
          .mockReturnValueOnce(createRedisClientDouble())
          .mockReturnValueOnce(createRedisClientDouble()),
      },
      adapterFactory: vi.fn(),
      log: createLogger(),
    });

    expect(() => lifecycle.connect()).toThrow('Socket.IO Redis adapter is not attached');
    lifecycle.attach({});
    expect(() => lifecycle.attach({})).toThrow('Socket.IO Redis adapter is already attached');
  });
});

describe('Socket.IO adapter readiness middleware', () => {
  it('accepts connections only while the adapter is ready', () => {
    const adapter = { isReady: vi.fn().mockReturnValue(true) };
    const middleware = createSocketAdapterReadinessMiddleware(adapter);
    const accepted = vi.fn();

    middleware({}, accepted);
    expect(accepted).toHaveBeenCalledWith();

    adapter.isReady.mockReturnValue(false);
    const rejected = vi.fn();
    middleware({}, rejected);

    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Realtime service is temporarily unavailable',
        data: {
          code: 'CONNECTION_UNAVAILABLE',
          message: 'Realtime service is temporarily unavailable',
        },
      }),
    );
  });
});

function createRedisClientDouble() {
  const client = new EventEmitter();
  client.isOpen = false;
  client.isReady = false;
  client.connect = vi.fn(async () => {
    client.isOpen = true;
    client.isReady = true;
    client.emit('ready');
    return client;
  });
  client.close = vi.fn(async () => {
    client.isOpen = false;
    client.isReady = false;
    client.emit('end');
  });

  return client;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
