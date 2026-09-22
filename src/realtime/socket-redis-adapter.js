import { createShardedAdapter } from '@socket.io/redis-adapter';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { closeRedisClient, connectRedisClient, observeRedisClient } from '../config/redis.js';

export function createSocketRedisAdapter({
  redisClient,
  adapterFactory = createShardedAdapter,
  channelPrefix = env.SOCKET_IO_REDIS_CHANNEL_PREFIX,
  log = logger,
} = {}) {
  requireRedisClient(redisClient);

  const publisher = observeRedisClient(redisClient.duplicate(), {
    log,
    role: 'socket_adapter_publisher',
  });
  const subscriber = observeRedisClient(redisClient.duplicate(), {
    log,
    role: 'socket_adapter_subscriber',
  });
  let io;
  let installed = false;
  let available = false;
  let closing = false;
  let connectionPromise;

  observeAvailability(publisher, 'publisher');
  observeAvailability(subscriber, 'subscriber');

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Socket.IO Redis adapter is already attached');
      }

      io = socketServer;
    },

    connect() {
      requireSocketServer(io);
      connectionPromise ??= connectAndInstall();

      return connectionPromise;
    },

    isReady() {
      return available && installed && publisher.isReady && subscriber.isReady;
    },

    async close() {
      closing = true;
      installed = false;
      available = false;

      await Promise.all([closeRedisClient(subscriber), closeRedisClient(publisher)]);
    },

    clients: { publisher, subscriber },
  };

  async function connectAndInstall() {
    await Promise.all([connectRedisClient(publisher), connectRedisClient(subscriber)]);

    if (closing) {
      return;
    }

    io.adapter(
      adapterFactory(publisher, subscriber, {
        channelPrefix,
        subscriptionMode: 'dynamic',
      }),
    );
    installed = true;
    updateAvailability();
  }

  function observeAvailability(client, role) {
    client.on('ready', updateAvailability);
    client.on('reconnecting', () => markUnavailable(role));
    client.on('end', () => markUnavailable(role));
    client.on('error', () => {
      if (!client.isReady) {
        markUnavailable(role);
      }
    });
  }

  function updateAvailability() {
    if (!installed || !publisher.isReady || !subscriber.isReady || available) {
      return;
    }

    available = true;
    log.info(
      {
        dependency: 'redis',
        event: 'socket_adapter_ready',
        status: 'available',
      },
      'Socket.IO Redis adapter is ready',
    );
  }

  function markUnavailable(role) {
    if (!available) {
      return;
    }

    available = false;
    log.error(
      {
        dependency: 'redis',
        event: 'socket_adapter_unavailable',
        redisRole: `socket_adapter_${role}`,
        status: 'unavailable',
      },
      'Socket.IO Redis adapter is unavailable',
    );
    io?.local.disconnectSockets(true);
  }
}

export function createSocketAdapterReadinessMiddleware(adapter) {
  return function requireSocketAdapterReadiness(socket, next) {
    void socket;

    if (adapter.isReady()) {
      next();
      return;
    }

    const error = new Error('Realtime service is temporarily unavailable');
    error.data = {
      code: 'CONNECTION_UNAVAILABLE',
      message: 'Realtime service is temporarily unavailable',
    };
    next(error);
  };
}

function requireRedisClient(redisClient) {
  if (!redisClient || typeof redisClient.duplicate !== 'function') {
    throw new TypeError('redisClient must support duplicate');
  }
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Socket.IO Redis adapter is not attached');
  }

  return io;
}
