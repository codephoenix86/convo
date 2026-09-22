import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createApplicationRateLimiters } from '../config/rate-limits.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { conversationsRepository } from '../modules/conversations/conversations.repository.js';
import { messagesService } from '../modules/messages/messages.service.js';
import { createSocketAuthenticator } from './authenticate.js';
import { createConversationRoomCoordinator } from './conversation-rooms.js';
import { registerMessageHandlers } from './handlers/messages.js';
import { registerTypingHandlers } from './handlers/typing.js';
import { createPresenceCoordinator } from './presence.js';
import { createSocketAdapterReadinessMiddleware } from './socket-redis-adapter.js';
import { createTypingCoordinator } from './typing.js';

export function createSocketServer(
  httpServer,
  {
    allowedOrigins = env.CLIENT_ORIGINS,
    accessTokenVerifier = verifyAccessToken,
    membershipRepository = conversationsRepository,
    roomCoordinator = createConversationRoomCoordinator(),
    presenceCoordinator = createPresenceCoordinator(),
    typingCoordinator = createTypingCoordinator(),
    typingRateLimit,
    messageSendRateLimiter = createApplicationRateLimiters().messageSend,
    messages = messagesService,
    socketAdapter,
    log = logger,
  } = {},
) {
  const allowedOriginSet = new Set(allowedOrigins);
  const io = new Server(httpServer, {
    serveClient: false,
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin;

      callback(null, origin === undefined || allowedOriginSet.has(origin));
    },
  });

  roomCoordinator.attach(io);
  presenceCoordinator.attach(io);
  typingCoordinator.attach(io);
  if (socketAdapter) {
    io.use(createSocketAdapterReadinessMiddleware(socketAdapter));
  }
  io.use(createSocketAuthenticator(accessTokenVerifier, log));
  io.use(createConversationRoomInitializer(roomCoordinator, membershipRepository, log));
  io.on('connection', (socket) => {
    const ready = roomCoordinator.connectSocket(socket);

    registerMessageHandlers(socket, { messages, ready, messageSendRateLimiter, log });
    registerTypingHandlers(socket, {
      ready,
      accessRepository: membershipRepository,
      typing: typingCoordinator,
      rateLimit: typingRateLimit,
      log,
    });
    void initializeConnectedSocket(socket, ready, presenceCoordinator, log);
  });

  return io;
}

async function initializeConnectedSocket(socket, ready, presenceCoordinator, log) {
  try {
    const initialized = await ready;

    if (initialized) {
      const tracked = await trackSocket(socket, presenceCoordinator, log);

      if (!tracked) {
        return;
      }

      socket.emit('session:ready', {
        connectionId: socket.id,
        serverTime: new Date().toISOString(),
        syncRequired: true,
      });
      await presenceCoordinator.sendSnapshot(socket);
    }
  } catch (error) {
    log.error(
      {
        err: error,
        event: 'socket_initialization_failed',
        socketId: socket.id,
        userId: socket.data.user.id,
      },
      'Socket initialization failed',
    );
    socket.disconnect(true);
  }
}

async function trackSocket(socket, presenceCoordinator, log) {
  const userId = socket.data.user.id;
  const connectedAt = Date.now();
  const counts = await presenceCoordinator.connectSocket(socket);
  let disconnectedCountsPromise = Promise.resolve();

  if (!socket.connected) {
    await presenceCoordinator.disconnectSocket(socket);
    return false;
  }

  socket.once('disconnecting', () => {
    disconnectedCountsPromise = Promise.resolve(presenceCoordinator.disconnectSocket(socket)).catch(
      (error) => {
        log.error(
          {
            err: error,
            event: 'presence_disconnect_cleanup_failed',
            socketId: socket.id,
            userId,
          },
          'Presence state cleanup failed',
        );

        return undefined;
      },
    );
  });

  socket.once('disconnect', (reason) => {
    void logDisconnection(reason);
  });

  log.info(
    {
      event: 'socket_connected',
      socketId: socket.id,
      userId,
      transport: socket.conn.transport.name,
      conversationRooms: socket.data.conversationIds.length,
      ...counts,
    },
    'Socket connected',
  );

  return true;

  async function logDisconnection(reason) {
    const disconnectedCounts = await disconnectedCountsPromise;

    log.info(
      {
        event: 'socket_disconnected',
        socketId: socket.id,
        userId,
        reason,
        connectedMs: Date.now() - connectedAt,
        ...disconnectedCounts,
      },
      'Socket disconnected',
    );
  }
}

function createConversationRoomInitializer(roomCoordinator, membershipRepository, log) {
  return async function initializeConversationRooms(socket, next) {
    try {
      await roomCoordinator.initializeSocket(socket, membershipRepository);
      next();
    } catch (error) {
      log.error(
        {
          err: error,
          event: 'socket_membership_load_failed',
          socketId: socket.id,
          userId: socket.data.user.id,
        },
        'Socket conversation memberships could not be loaded',
      );

      const connectionError = new Error('Unable to establish socket connection');
      connectionError.data = {
        code: 'CONNECTION_UNAVAILABLE',
        message: 'Unable to establish socket connection',
      };
      next(connectionError);
    }
  };
}
