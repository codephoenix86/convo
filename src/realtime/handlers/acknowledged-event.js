import { AppError } from '../../lib/errors.js';
import { createSocketEventError } from '../errors.js';

export function registerAcknowledgedEvent(socket, { eventName, ready, log, handle }) {
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
