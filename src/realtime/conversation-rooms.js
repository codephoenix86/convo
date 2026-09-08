import { getConversationRoom, getUserRoom } from './rooms.js';

export function createConversationRoomCoordinator() {
  let io;
  const pendingSocketsByUser = new Map();
  const userOperations = new Map();

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Conversation room coordinator is already attached');
      }

      io = socketServer;
    },

    initializeSocket(socket, membershipRepository) {
      const userId = socket.data.user.id;

      return runForUser(userId, async () => {
        const conversationIds = await membershipRepository.listConversationIdsForUser(userId);

        socket.data.conversationIds = conversationIds;
        addPendingSocket(userId, socket);

        return conversationIds;
      });
    },

    connectSocket(socket) {
      const userId = socket.data.user.id;

      return runForUser(userId, async () => {
        if (!socket.connected) {
          removePendingSocket(userId, socket);
          return false;
        }

        await socket.join([
          getUserRoom(userId),
          ...socket.data.conversationIds.map(getConversationRoom),
        ]);
        removePendingSocket(userId, socket);

        return true;
      });
    },

    async membersAdded({ conversationId, userIds }) {
      const socketServer = requireSocketServer(io);
      const conversationRoom = getConversationRoom(conversationId);

      await Promise.all(
        [...new Set(userIds)].map((userId) =>
          runForUser(userId, () => {
            updatePendingSockets(userId, (socket) => {
              socket.data.conversationIds = [
                ...new Set([...socket.data.conversationIds, conversationId]),
              ].sort();
            });

            return socketServer.in(getUserRoom(userId)).socketsJoin(conversationRoom);
          }),
        ),
      );
    },

    memberRemoved({ conversationId, userId }) {
      const socketServer = requireSocketServer(io);

      return runForUser(userId, () => {
        updatePendingSockets(userId, (socket) => {
          socket.data.conversationIds = socket.data.conversationIds.filter(
            (id) => id !== conversationId,
          );
        });

        return socketServer
          .in(getUserRoom(userId))
          .socketsLeave(getConversationRoom(conversationId));
      });
    },
  };

  function addPendingSocket(userId, socket) {
    const pendingSockets = pendingSocketsByUser.get(userId) ?? new Set();

    pendingSockets.add(socket);
    pendingSocketsByUser.set(userId, pendingSockets);
    socket.conn.once('close', () => removePendingSocket(userId, socket));
  }

  function removePendingSocket(userId, socket) {
    const pendingSockets = pendingSocketsByUser.get(userId);

    if (!pendingSockets) {
      return;
    }

    pendingSockets.delete(socket);

    if (pendingSockets.size === 0) {
      pendingSocketsByUser.delete(userId);
    }
  }

  function updatePendingSockets(userId, update) {
    for (const socket of pendingSocketsByUser.get(userId) ?? []) {
      update(socket);
    }
  }

  function runForUser(userId, operation) {
    const previousOperation = userOperations.get(userId) ?? Promise.resolve();
    const currentOperation = previousOperation.catch(() => {}).then(operation);

    userOperations.set(userId, currentOperation);

    return currentOperation.finally(() => {
      if (userOperations.get(userId) === currentOperation) {
        userOperations.delete(userId);
      }
    });
  }
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Conversation room coordinator is not attached');
  }

  return io;
}
