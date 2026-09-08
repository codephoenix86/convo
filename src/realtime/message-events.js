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
  };
}

function requireSocketServer(io) {
  if (!io) {
    throw new Error('Realtime message events are not attached');
  }

  return io;
}
