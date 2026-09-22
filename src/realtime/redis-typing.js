import { logger } from '../config/logger.js';
import { getConversationRoom } from './rooms.js';

const DEFAULT_TYPING_TTL_MS = 5_000;
const DEFAULT_BROADCAST_INTERVAL_MS = 1_000;
const TYPING_KEY_PREFIX = 'convo:{typing}';

const START_SCRIPT = `
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
local ttl = tonumber(ARGV[2])
local expiresAt = now + ttl

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], expiresAt, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl * 2)

local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
local shouldBroadcast = redis.call('SET', KEYS[2], '1', 'PX', ARGV[3], 'NX')

return { expiresAt, latest[2], shouldBroadcast and 1 or 0 }
`;

const STOP_SCRIPT = `
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
local hadState = redis.call('ZCARD', KEYS[1]) > 0

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREM', KEYS[1], ARGV[1])

local remaining = redis.call('ZCARD', KEYS[1])
local latestExpiry = 0

if remaining == 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
else
  local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
  latestExpiry = latest[2]
end

return { remaining, latestExpiry, hadState and remaining == 0 and 1 or 0 }
`;

export function createRedisTypingCoordinator({
  redisClient,
  ttlMs = DEFAULT_TYPING_TTL_MS,
  broadcastIntervalMs = DEFAULT_BROADCAST_INTERVAL_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  log = logger,
} = {}) {
  const store = createRedisTypingStore(redisClient, { ttlMs, broadcastIntervalMs });
  let io;
  const entriesBySocket = new Map();

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Typing coordinator is already attached');
      }

      io = socketServer;
    },

    async start({ conversationId, userId, socketId }) {
      requireSocketServer(io);
      const result = await store.start({ conversationId, userId, socketId });

      replaceLocalExpiry({ conversationId, userId, socketId });

      if (result.shouldBroadcast) {
        publish(
          io,
          'typing:start',
          createTypingState(conversationId, userId, true, result.aggregateExpiresAt),
        );
      }

      return createTypingState(conversationId, userId, true, result.expiresAt);
    },

    async stop(input) {
      requireSocketServer(io);
      removeLocalEntry(input);

      return stopStoredEntry(input);
    },

    async disconnectSocket(socketId) {
      const entries = [...(entriesBySocket.get(socketId)?.values() ?? [])];

      entriesBySocket.delete(socketId);
      for (const entry of entries) {
        cancel(entry.expiryTimer);
      }

      await Promise.all(entries.map(stopStoredEntry));
    },
  };

  function replaceLocalExpiry(input) {
    removeLocalEntry(input);

    const expiryTimer = schedule(() => {
      void expireLocalEntry(input).catch((error) => {
        log.error(
          {
            err: error,
            event: 'typing_expiry_failed',
            socketId: input.socketId,
            userId: input.userId,
            conversationId: input.conversationId,
          },
          'Typing state expiry failed',
        );
      });
    }, ttlMs);

    expiryTimer.unref?.();

    const socketEntries = entriesBySocket.get(input.socketId) ?? new Map();
    socketEntries.set(createStateKey(input), { ...input, expiryTimer });
    entriesBySocket.set(input.socketId, socketEntries);
  }

  async function expireLocalEntry(input) {
    removeLocalEntry(input);
    await stopStoredEntry(input);
  }

  function removeLocalEntry(input) {
    const socketEntries = entriesBySocket.get(input.socketId);
    const entry = socketEntries?.get(createStateKey(input));

    if (!entry) {
      return;
    }

    cancel(entry.expiryTimer);
    socketEntries.delete(createStateKey(input));

    if (socketEntries.size === 0) {
      entriesBySocket.delete(input.socketId);
    }
  }

  async function stopStoredEntry({ conversationId, userId, socketId }) {
    const result = await store.stop({ conversationId, userId, socketId });

    if (result.transitionedStopped) {
      publish(io, 'typing:stop', createTypingState(conversationId, userId, false, null));
    }

    return createTypingState(
      conversationId,
      userId,
      result.remaining > 0,
      result.remaining > 0 ? result.aggregateExpiresAt : null,
    );
  }
}

export function createRedisTypingStore(
  redisClient,
  { ttlMs = DEFAULT_TYPING_TTL_MS, broadcastIntervalMs = DEFAULT_BROADCAST_INTERVAL_MS } = {},
) {
  requireRedisClient(redisClient);
  requirePositiveInteger(ttlMs, 'ttlMs');
  requirePositiveInteger(broadcastIntervalMs, 'broadcastIntervalMs');

  return {
    async start({ conversationId, userId, socketId }) {
      const result = await redisClient.eval(START_SCRIPT, {
        keys: [getTypingKey(conversationId, userId), getBroadcastKey(conversationId, userId)],
        arguments: [socketId, String(ttlMs), String(broadcastIntervalMs)],
      });

      return {
        expiresAt: Number(result[0]),
        aggregateExpiresAt: Number(result[1]),
        shouldBroadcast: Number(result[2]) === 1,
      };
    },

    async stop({ conversationId, userId, socketId }) {
      const result = await redisClient.eval(STOP_SCRIPT, {
        keys: [getTypingKey(conversationId, userId), getBroadcastKey(conversationId, userId)],
        arguments: [socketId],
      });

      return {
        remaining: Number(result[0]),
        aggregateExpiresAt: Number(result[1]),
        transitionedStopped: Number(result[2]) === 1,
      };
    },
  };
}

function getTypingKey(conversationId, userId) {
  return `${TYPING_KEY_PREFIX}:${conversationId}:${userId}:sockets`;
}

function getBroadcastKey(conversationId, userId) {
  return `${TYPING_KEY_PREFIX}:${conversationId}:${userId}:broadcast`;
}

function createStateKey({ conversationId, userId }) {
  return `${conversationId}:${userId}`;
}

function createTypingState(conversationId, userId, isTyping, expiresAt) {
  return {
    conversationId,
    userId,
    isTyping,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  };
}

function publish(io, eventName, typing) {
  requireSocketServer(io)
    .to(getConversationRoom(typing.conversationId))
    .emit(eventName, { typing });
}

function requireRedisClient(redisClient) {
  if (!redisClient || typeof redisClient.eval !== 'function') {
    throw new TypeError('redisClient must support eval');
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Typing coordinator is not attached');
  }

  return io;
}
