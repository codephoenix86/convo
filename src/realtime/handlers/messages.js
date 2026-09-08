import { AppError } from '../../lib/errors.js';
import { createSocketEventError } from '../errors.js';

const MESSAGE_SEND_EVENT = 'message:send';

export function registerMessageHandlers(socket, { messages, ready, log }) {
  socket.on(MESSAGE_SEND_EVENT, async (payload, acknowledgement) => {
    const acknowledge = typeof acknowledgement === 'function' ? acknowledgement : () => {};

    try {
      await ready;
      const result = await messages.send(socket.data.user.id, payload);

      acknowledge({
        ok: true,
        data: {
          message: result.message,
          created: result.created,
        },
      });
    } catch (error) {
      logSocketEventFailure(error, socket, log);
      acknowledge({ ok: false, error: createSocketEventError(error) });
    }
  });
}

function logSocketEventFailure(error, socket, log) {
  const context = {
    event: 'socket_event_failed',
    socketEvent: MESSAGE_SEND_EVENT,
    socketId: socket.id,
    userId: socket.data.user.id,
  };

  if (error instanceof AppError) {
    log.warn({ ...context, errorCode: error.code }, 'Socket event rejected');
    return;
  }

  log.error({ ...context, err: error }, 'Socket event failed');
}
