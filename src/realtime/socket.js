import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { conversationsRepository } from '../modules/conversations/conversations.repository.js';
import { messagesService } from '../modules/messages/messages.service.js';
import { createSocketAuthenticator } from './authenticate.js';
import { createConversationRoomCoordinator } from './conversation-rooms.js';
import { registerMessageHandlers } from './handlers/messages.js';
import { registerTypingHandlers } from './handlers/typing.js';
import { createPresenceCoordinator } from './presence.js';
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
    messages = messagesService,
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
  io.use(createSocketAuthenticator(accessTokenVerifier, log));
  io.use(createConversationRoomInitializer(roomCoordinator, membershipRepository, log));
  io.on('connection', (socket) => {
    const ready = roomCoordinator.connectSocket(socket);

    registerMessageHandlers(socket, { messages, ready, log });
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
      trackSocket(socket, presenceCoordinator, log);
      socket.emit('session:ready', {
        connectionId: socket.id,
        serverTime: new Date().toISOString(),
        syncRequired: true,
      });
      presenceCoordinator.sendSnapshot(socket);
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

function trackSocket(socket, presenceCoordinator, log) {
  const userId = socket.data.user.id;
  const connectedAt = Date.now();
  const counts = presenceCoordinator.connectSocket(socket);
  let disconnectedCounts;

  socket.once('disconnecting', () => {
    disconnectedCounts = presenceCoordinator.disconnectSocket(socket);
  });

  socket.once('disconnect', (reason) => {
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
