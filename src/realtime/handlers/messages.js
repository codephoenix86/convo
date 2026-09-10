import { AppError } from '../../lib/errors.js';
import { createSocketEventError } from '../errors.js';

const MESSAGE_SEND_EVENT = 'message:send';
const MESSAGE_DELIVERED_EVENT = 'message:delivered';
const CONVERSATION_READ_EVENT = 'conversation:read';

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
}

function registerAcknowledgedEvent(socket, { eventName, ready, log, handle }) {
  socket.on(eventName, async (payload, acknowledgement) => {
    const acknowledge = typeof acknowledgement === 'function' ? acknowledgement : () => {};

    try {
      await ready;
      const data = await handle(payload);

      acknowledge({ ok: true, data });
    } catch (error) {
      logSocketEventFailure(error, socket, eventName, log);
      acknowledge({ ok: false, error: createSocketEventError(error) });
    }
  });
}

function logSocketEventFailure(error, socket, socketEvent, log) {
  const context = {
    event: 'socket_event_failed',
    socketEvent,
    socketId: socket.id,
    userId: socket.data.user.id,
  };

  if (error instanceof AppError) {
    log.warn({ ...context, errorCode: error.code }, 'Socket event rejected');
    return;
  }

  log.error({ ...context, err: error }, 'Socket event failed');
}
