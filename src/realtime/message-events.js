import { getConversationRoom } from './rooms.js';

export function createRealtimeMessageEvents() {
  let io;

  return {
    attach(socketServer) {
      if (io) {
        throw new Error('Realtime message events are already attached');
      }

      io = socketServer;
    },

    async messageCreated({ message }) {
      const socketServer = requireSocketServer(io);

      socketServer.to(getConversationRoom(message.conversationId)).emit('message:new', { message });
    },

    async messageDelivered({ receipt }) {
      const socketServer = requireSocketServer(io);

      socketServer
        .to(getConversationRoom(receipt.conversationId))
        .emit('message:delivered', { receipt });
    },

    async conversationRead({ receipt }) {
      const socketServer = requireSocketServer(io);

      socketServer
        .to(getConversationRoom(receipt.conversationId))
        .emit('conversation:read', { receipt });
    },

    async messageEdited({ message }) {
      const socketServer = requireSocketServer(io);

      socketServer.to(getConversationRoom(message.conversationId)).emit('message:edited', {
        message,
      });
    },

    async messageDeleted({ message }) {
      const socketServer = requireSocketServer(io);

      socketServer.to(getConversationRoom(message.conversationId)).emit('message:deleted', {
        message,
      });
    },
  };
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Realtime message events are not attached');
  }

  return io;
}
