import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { createSocketAuthenticator } from './authenticate.js';
import { getUserRoom } from './rooms.js';

export function createSocketServer(
  httpServer,
  {
    allowedOrigins = env.CLIENT_ORIGINS,
    accessTokenVerifier = verifyAccessToken,
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

  io.use(createSocketAuthenticator(accessTokenVerifier, log));
  io.on('connection', (socket) => {
    void initializeSocket(socket, connectionTracker, log);
  });

  return io;
}

async function initializeSocket(socket, connectionTracker, log) {
  const userId = socket.data.user.id;
  let connectedAt;
  let isTracked = false;

  socket.once('disconnect', (reason) => {
    if (!isTracked) {
      return;
    }

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

  try {
    await socket.join(getUserRoom(userId));
  } catch (error) {
    log.error(
      { err: error, event: 'socket_initialization_failed', socketId: socket.id, userId },
      'Socket initialization failed',
    );
    socket.disconnect(true);
    return;
  }

  if (!socket.connected) {
    return;
  }

  connectedAt = Date.now();
  const counts = connectionTracker.connect(userId);
  isTracked = true;

  log.info(
    {
      event: 'socket_connected',
      socketId: socket.id,
      userId,
      transport: socket.conn.transport.name,
      ...counts,
    },
    'Socket connected',
  );
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
