import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { conversationsRepository } from '../modules/conversations/conversations.repository.js';
import { messagesService } from '../modules/messages/messages.service.js';
import { createSocketAuthenticator } from './authenticate.js';
import { createConversationRoomCoordinator } from './conversation-rooms.js';
import { registerMessageHandlers } from './handlers/messages.js';

export function createSocketServer(
  httpServer,
  {
    allowedOrigins = env.CLIENT_ORIGINS,
    accessTokenVerifier = verifyAccessToken,
    membershipRepository = conversationsRepository,
    roomCoordinator = createConversationRoomCoordinator(),
    messages = messagesService,
    log = logger,
  } = {},
) {
  const allowedOriginSet = new Set(allowedOrigins);
  const connectionTracker = createConnectionTracker();

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
  io.use(createSocketAuthenticator(accessTokenVerifier, log));
  io.use(createConversationRoomInitializer(roomCoordinator, membershipRepository, log));
  io.on('connection', (socket) => {
    const ready = roomCoordinator.connectSocket(socket);

    registerMessageHandlers(socket, { messages, ready, log });
    void initializeConnectedSocket(socket, ready, connectionTracker, log);
  });

  return io;
}

async function initializeConnectedSocket(socket, ready, connectionTracker, log) {
  try {
    const initialized = await ready;

    if (initialized) {
      trackSocket(socket, connectionTracker, log);
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

function trackSocket(socket, connectionTracker, log) {
  const userId = socket.data.user.id;
  const connectedAt = Date.now();
  const counts = connectionTracker.connect(userId);

  socket.once('disconnect', (reason) => {
    const updatedCounts = connectionTracker.disconnect(userId);

    log.info(
      {
        event: 'socket_disconnected',
        socketId: socket.id,
        userId,
        reason,
        connectedMs: Date.now() - connectedAt,
        ...updatedCounts,
      },
      'Socket disconnected',
    );
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

function createConnectionTracker() {
  let activeConnections = 0;
  const connectionsByUser = new Map();

  return {
    connect(userId) {
      activeConnections += 1;
      connectionsByUser.set(userId, (connectionsByUser.get(userId) ?? 0) + 1);

      return snapshot(userId);
    },

    disconnect(userId) {
      activeConnections = Math.max(0, activeConnections - 1);
      const userConnections = Math.max(0, (connectionsByUser.get(userId) ?? 1) - 1);

      if (userConnections === 0) {
        connectionsByUser.delete(userId);
      } else {
        connectionsByUser.set(userId, userConnections);
      }

      return snapshot(userId);
    },
  };

  function snapshot(userId) {
    return {
      activeConnections,
      activeUsers: connectionsByUser.size,
      userConnections: connectionsByUser.get(userId) ?? 0,
    };
  }
}
