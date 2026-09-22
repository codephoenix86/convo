import { logger } from '../config/logger.js';

const CONVERSATION_ROOM_PREFIX = 'conversation:';
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const PRESENCE_KEY_PREFIX = 'convo:{presence}';

const CONNECT_SCRIPT = `
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
local ttl = tonumber(ARGV[3])
local expiresAt = now + ttl

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)

local wasOffline = redis.call('ZCARD', KEYS[3]) == 0
redis.call('ZADD', KEYS[1], expiresAt, ARGV[1])
redis.call('ZADD', KEYS[2], expiresAt, ARGV[2])
redis.call('ZADD', KEYS[3], expiresAt, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl * 2)
redis.call('PEXPIRE', KEYS[2], ttl * 2)
redis.call('PEXPIRE', KEYS[3], ttl * 2)

local onlineSince = redis.call('GET', KEYS[4])
local transitionedOnline = wasOffline or not onlineSince
if transitionedOnline then
  onlineSince = tostring(now)
  redis.call('SET', KEYS[4], onlineSince, 'PX', ttl)
else
  redis.call('PEXPIRE', KEYS[4], ttl)
end

return {
  redis.call('ZCARD', KEYS[1]),
  redis.call('ZCARD', KEYS[2]),
  redis.call('ZCARD', KEYS[3]),
  onlineSince,
  transitionedOnline and 1 or 0
}
`;

const DISCONNECT_SCRIPT = `
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local wasOnline = redis.call('EXISTS', KEYS[4]) == 1

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)

local userConnections = redis.call('ZCARD', KEYS[3])
if userConnections == 0 then
  redis.call('ZREM', KEYS[2], ARGV[2])
  redis.call('DEL', KEYS[3], KEYS[4])
else
  local latest = redis.call('ZRANGE', KEYS[3], -1, -1, 'WITHSCORES')
  local latestExpiry = tonumber(latest[2])
  local remainingTtl = math.max(1, latestExpiry - now)
  redis.call('ZADD', KEYS[2], latestExpiry, ARGV[2])
  redis.call('PEXPIRE', KEYS[3], remainingTtl * 2)
  redis.call('PEXPIRE', KEYS[4], remainingTtl)
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

return {
  redis.call('ZCARD', KEYS[1]),
  redis.call('ZCARD', KEYS[2]),
  userConnections,
  wasOnline and userConnections == 0 and 1 or 0,
  now
}
`;

export function createRedisPresenceCoordinator({
  redisClient,
  membershipRepository,
  ttlMs = DEFAULT_PRESENCE_TTL_MS,
  heartbeatIntervalMs = Math.floor(ttlMs / 3),
  scheduleHeartbeat = setInterval,
  cancelHeartbeat = clearInterval,
  log = logger,
} = {}) {
  requirePositiveInteger(ttlMs, 'ttlMs');
  requirePositiveInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');

  if (heartbeatIntervalMs >= ttlMs) {
    throw new TypeError('heartbeatIntervalMs must be shorter than ttlMs');
  }

  requireMembershipRepository(membershipRepository);
  const store = createRedisPresenceStore(redisClient, { ttlMs });
  let io;
  const heartbeatTimers = new Map();

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Presence coordinator is already attached');
      }

      io = socketServer;
    },

    async connectSocket(socket) {
      requireSocketServer(io);
      const userId = socket.data.user.id;
      const result = await store.connect(socket.id, userId);

      replaceHeartbeat(socket);

      if (result.transitionedOnline) {
        publishFromSocket(
          socket,
          'presence:update',
          createPresenceState(userId, true, result.onlineSince),
        );
      }

      return result.counts;
    },

    async disconnectSocket(socket) {
      const conversationRooms = getConversationRooms(socket);
      const userId = socket.data.user.id;

      clearSocketHeartbeat(socket.id);

      const result = await store.disconnect(socket.id, userId);

      if (result.transitionedOffline) {
        publishToRooms(
          socket,
          conversationRooms,
          'presence:update',
          createPresenceState(userId, false, result.changedAt),
        );
      }

      return result.counts;
    },

    async sendSnapshot(socket) {
      const conversationIds = getConversationRooms(socket).map((roomName) =>
        roomName.slice(CONVERSATION_ROOM_PREFIX.length),
      );
      const memberIds = await membershipRepository.listMemberIdsForConversations(conversationIds);
      const visibleUserIds = [...new Set(memberIds)].filter(
        (userId) => userId !== socket.data.user.id,
      );
      const onlineUsers = await store.getOnline(visibleUserIds);
      const items = onlineUsers
        .sort((first, second) => first.userId.localeCompare(second.userId))
        .map(({ userId, onlineSince }) => createPresenceState(userId, true, onlineSince));

      socket.emit('presence:snapshot', { items });

      return items;
    },
  };

  function replaceHeartbeat(socket) {
    clearSocketHeartbeat(socket.id);

    const timer = scheduleHeartbeat(() => {
      void refreshPresence(socket).catch((error) => {
        log.error(
          {
            err: error,
            event: 'presence_heartbeat_failed',
            socketId: socket.id,
            userId: socket.data.user.id,
          },
          'Presence heartbeat failed',
        );
      });
    }, heartbeatIntervalMs);

    timer.unref?.();
    heartbeatTimers.set(socket.id, timer);
  }

  async function refreshPresence(socket) {
    const result = await store.connect(socket.id, socket.data.user.id);

    if (result.transitionedOnline) {
      publishFromSocket(
        socket,
        'presence:update',
        createPresenceState(socket.data.user.id, true, result.onlineSince),
      );
    }
  }

  function clearSocketHeartbeat(socketId) {
    const timer = heartbeatTimers.get(socketId);

    if (timer) {
      cancelHeartbeat(timer);
      heartbeatTimers.delete(socketId);
    }
  }
}

export function createRedisPresenceStore(redisClient, { ttlMs = DEFAULT_PRESENCE_TTL_MS } = {}) {
  requireRedisClient(redisClient);
  requirePositiveInteger(ttlMs, 'ttlMs');

  return {
    async connect(socketId, userId) {
      const result = await redisClient.eval(CONNECT_SCRIPT, {
        keys: [
          `${PRESENCE_KEY_PREFIX}:connections`,
          `${PRESENCE_KEY_PREFIX}:users`,
          getUserConnectionsKey(userId),
          getOnlineSinceKey(userId),
        ],
        arguments: [socketId, userId, String(ttlMs)],
      });

      return {
        counts: createCounts(result),
        onlineSince: new Date(Number(result[3])).toISOString(),
        transitionedOnline: Number(result[4]) === 1,
      };
    },

    async disconnect(socketId, userId) {
      const result = await redisClient.eval(DISCONNECT_SCRIPT, {
        keys: [
          `${PRESENCE_KEY_PREFIX}:connections`,
          `${PRESENCE_KEY_PREFIX}:users`,
          getUserConnectionsKey(userId),
          getOnlineSinceKey(userId),
        ],
        arguments: [socketId, userId],
      });

      return {
        counts: createCounts(result),
        transitionedOffline: Number(result[3]) === 1,
        changedAt: new Date(Number(result[4])).toISOString(),
      };
    },

    async getOnline(userIds) {
      if (userIds.length === 0) {
        return [];
      }

      const onlineSinceValues = await redisClient.mGet(userIds.map(getOnlineSinceKey));

      return userIds.flatMap((userId, index) => {
        const onlineSince = onlineSinceValues[index];

        return onlineSince === null
          ? []
          : [{ userId, onlineSince: new Date(Number(onlineSince)).toISOString() }];
      });
    },
  };
}

function createCounts(result) {
  return {
    activeConnections: Number(result[0]),
    activeUsers: Number(result[1]),
    userConnections: Number(result[2]),
  };
}

function getUserConnectionsKey(userId) {
  return `${PRESENCE_KEY_PREFIX}:user:${userId}:connections`;
}

function getOnlineSinceKey(userId) {
  return `${PRESENCE_KEY_PREFIX}:user:${userId}:online-since`;
}

function publishFromSocket(socket, eventName, presence) {
  publishToRooms(socket, getConversationRooms(socket), eventName, presence);
}

function publishToRooms(socket, conversationRooms, eventName, presence) {
  if (conversationRooms.length > 0) {
    socket.to(conversationRooms).emit(eventName, { presence });
  }
}

function getConversationRooms(socket) {
  return [...socket.rooms].filter((roomName) => roomName.startsWith(CONVERSATION_ROOM_PREFIX));
}

function createPresenceState(userId, isOnline, changedAt) {
  return { userId, isOnline, changedAt };
}

function requireRedisClient(redisClient) {
  if (
    !redisClient ||
    typeof redisClient.eval !== 'function' ||
    typeof redisClient.mGet !== 'function'
  ) {
    throw new TypeError('redisClient must support eval and mGet');
  }
}

function requireMembershipRepository(membershipRepository) {
  if (
    !membershipRepository ||
    typeof membershipRepository.listMemberIdsForConversations !== 'function'
  ) {
    throw new TypeError('membershipRepository must support listMemberIdsForConversations');
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Presence coordinator is not attached');
  }

  return io;
}
