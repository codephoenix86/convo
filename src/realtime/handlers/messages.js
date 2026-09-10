import { registerAcknowledgedEvent } from './acknowledged-event.js';

const MESSAGE_SEND_EVENT = 'message:send';
const MESSAGE_DELIVERED_EVENT = 'message:delivered';
const CONVERSATION_READ_EVENT = 'conversation:read';
const MESSAGE_EDIT_EVENT = 'message:edit';
const MESSAGE_DELETE_EVENT = 'message:delete';

export function registerMessageHandlers(socket, { messages, ready, log }) {
  registerAcknowledgedEvent(socket, {
    eventName: MESSAGE_SEND_EVENT,
    ready,
    log,
    handle: async (payload) => {
      const result = await messages.send(socket.data.user.id, payload);

      return { message: result.message, created: result.created };
    },
  });
  registerAcknowledgedEvent(socket, {
    eventName: MESSAGE_DELIVERED_EVENT,
    ready,
    log,
    handle: async (payload) => ({
      receipt: await messages.markDelivered(socket.data.user.id, payload),
    }),
  });
  registerAcknowledgedEvent(socket, {
    eventName: CONVERSATION_READ_EVENT,
    ready,
    log,
    handle: async (payload) => ({
      receipt: await messages.markRead(socket.data.user.id, payload),
    }),
  });
  registerAcknowledgedEvent(socket, {
    eventName: MESSAGE_EDIT_EVENT,
    ready,
    log,
    handle: async (payload) => ({
      message: await messages.edit(socket.data.user.id, payload),
    }),
  });
  registerAcknowledgedEvent(socket, {
    eventName: MESSAGE_DELETE_EVENT,
    ready,
    log,
    handle: async (payload) => ({
      message: await messages.delete(socket.data.user.id, payload),
    }),
  });
}
