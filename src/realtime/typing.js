import { getConversationRoom } from './rooms.js';

const DEFAULT_TYPING_TTL_MS = 5_000;
const DEFAULT_BROADCAST_INTERVAL_MS = 1_000;

export function createTypingCoordinator({
  ttlMs = DEFAULT_TYPING_TTL_MS,
  broadcastIntervalMs = DEFAULT_BROADCAST_INTERVAL_MS,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let io;
  const states = new Map();
  const keysBySocket = new Map();

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Typing coordinator is already attached');
      }

      io = socketServer;
    },

    start({ conversationId, userId, socketId }) {
      requireSocketServer(io);
      const socketKey = createSocketKey(conversationId, userId);
      const state = getOrCreateState(conversationId, userId);
      const currentTime = now();
      const expiresAt = currentTime + ttlMs;
      const existingSocket = state.sockets.get(socketId);

      if (existingSocket) {
        cancel(existingSocket.expiryTimer);
      }

      const expiryTimer = schedule(() => expireSocket({ conversationId, userId, socketId }), ttlMs);
      expiryTimer.unref?.();
      state.sockets.set(socketId, { expiresAt, expiryTimer });
      addSocketKey(socketId, socketKey);

      if (
        state.lastBroadcastAt === undefined ||
        currentTime - state.lastBroadcastAt >= broadcastIntervalMs
      ) {
        state.lastBroadcastAt = currentTime;
        publish('typing:start', createTypingState(conversationId, userId, true, expiresAt));
      }

      return createTypingState(conversationId, userId, true, expiresAt);
    },

    stop({ conversationId, userId, socketId }) {
      return removeSocket({ conversationId, userId, socketId });
    },

    disconnectSocket(socketId) {
      for (const socketKey of [...(keysBySocket.get(socketId) ?? [])]) {
        const { conversationId, userId } = parseSocketKey(socketKey);

        removeSocket({ conversationId, userId, socketId });
      }
    },
  };

  function getOrCreateState(conversationId, userId) {
    const stateKey = createSocketKey(conversationId, userId);
    let state = states.get(stateKey);

    if (!state) {
      state = { sockets: new Map(), lastBroadcastAt: undefined };
      states.set(stateKey, state);
    }

    return state;
  }

  function removeSocket({ conversationId, userId, socketId }) {
    const stateKey = createSocketKey(conversationId, userId);
    const state = states.get(stateKey);
    const socketState = state?.sockets.get(socketId);

    if (socketState) {
      cancel(socketState.expiryTimer);
      state.sockets.delete(socketId);
      removeSocketKey(socketId, stateKey);
    }

    if (state?.sockets.size) {
      const expiresAt = Math.max(...[...state.sockets.values()].map((entry) => entry.expiresAt));

      return createTypingState(conversationId, userId, true, expiresAt);
    }

    if (state) {
      states.delete(stateKey);
      publish('typing:stop', createTypingState(conversationId, userId, false, null));
    }

    return createTypingState(conversationId, userId, false, null);
  }

  function expireSocket(input) {
    removeSocket(input);
  }

  function addSocketKey(socketId, stateKey) {
    const socketKeys = keysBySocket.get(socketId) ?? new Set();

    socketKeys.add(stateKey);
    keysBySocket.set(socketId, socketKeys);
  }

  function removeSocketKey(socketId, stateKey) {
    const socketKeys = keysBySocket.get(socketId);

    if (!socketKeys) {
      return;
    }

    socketKeys.delete(stateKey);

    if (socketKeys.size === 0) {
      keysBySocket.delete(socketId);
    }
  }

  function publish(eventName, typing) {
    requireSocketServer(io)
      .to(getConversationRoom(typing.conversationId))
      .emit(eventName, { typing });
  }
}

function createTypingState(conversationId, userId, isTyping, expiresAt) {
  return {
    conversationId,
    userId,
    isTyping,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  };
}

function createSocketKey(conversationId, userId) {
  return `${conversationId}:${userId}`;
}

function parseSocketKey(socketKey) {
  const separatorIndex = socketKey.indexOf(':');

  return {
    conversationId: socketKey.slice(0, separatorIndex),
    userId: socketKey.slice(separatorIndex + 1),
  };
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Typing coordinator is not attached');
  }

  return io;
}
