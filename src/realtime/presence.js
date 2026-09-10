const CONVERSATION_ROOM_PREFIX = 'conversation:';

export function createPresenceCoordinator({ now = Date.now } = {}) {
  let io;
  let activeConnections = 0;
  const users = new Map();

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Presence coordinator is already attached');
      }

      io = socketServer;
    },

    connectSocket(socket) {
      requireSocketServer(io);
      const userId = socket.data.user.id;
      const userState = users.get(userId) ?? {
        socketIds: new Set(),
        onlineSince: new Date(now()).toISOString(),
      };
      const wasOffline = userState.socketIds.size === 0;

      userState.socketIds.add(socket.id);
      users.set(userId, userState);
      activeConnections += 1;

      if (wasOffline) {
        publishFromSocket(
          socket,
          'presence:update',
          createPresenceState(userId, true, userState.onlineSince),
        );
      }

      return createCounts(userId);
    },

    disconnectSocket(socket) {
      const userId = socket.data.user.id;
      const userState = users.get(userId);

      if (!userState?.socketIds.delete(socket.id)) {
        return createCounts(userId);
      }

      activeConnections = Math.max(0, activeConnections - 1);

      if (userState.socketIds.size === 0) {
        users.delete(userId);
        publishFromSocket(
          socket,
          'presence:update',
          createPresenceState(userId, false, new Date(now()).toISOString()),
        );
      }

      return createCounts(userId);
    },

    sendSnapshot(socket) {
      const namespace = requireSocketServer(io).of('/');
      const visibleUserIds = new Set();

      for (const roomName of getConversationRooms(socket)) {
        for (const socketId of namespace.adapter.rooms.get(roomName) ?? []) {
          const visibleUserId = namespace.sockets.get(socketId)?.data.user.id;

          if (visibleUserId && visibleUserId !== socket.data.user.id && users.has(visibleUserId)) {
            visibleUserIds.add(visibleUserId);
          }
        }
      }

      const items = [...visibleUserIds]
        .sort()
        .map((userId) => createPresenceState(userId, true, users.get(userId).onlineSince));

      socket.emit('presence:snapshot', { items });

      return items;
    },
  };

  function createCounts(userId) {
    return {
      activeConnections,
      activeUsers: users.size,
      userConnections: users.get(userId)?.socketIds.size ?? 0,
    };
  }
}

function publishFromSocket(socket, eventName, presence) {
  const conversationRooms = getConversationRooms(socket);

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

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Presence coordinator is not attached');
  }

  return io;
}
