import { z } from 'zod';

import { RateLimitError, ValidationError } from '../../lib/errors.js';
import { requireConversationMember } from '../../modules/conversations/conversation-access.js';
import { registerAcknowledgedEvent } from './acknowledged-event.js';

const TYPING_START_EVENT = 'typing:start';
const TYPING_STOP_EVENT = 'typing:stop';
const typingCommandSchema = z.object({ conversationId: z.uuid() }).strict();

export function registerTypingHandlers(
  socket,
  { ready, accessRepository, typing, log, rateLimit },
) {
  const limiter = createTypingRateLimiter(rateLimit);

  register(TYPING_START_EVENT, (command) =>
    typing.start({ ...command, userId: socket.data.user.id, socketId: socket.id }),
  );
  register(TYPING_STOP_EVENT, (command) =>
    typing.stop({ ...command, userId: socket.data.user.id, socketId: socket.id }),
  );
  socket.once('disconnect', () => typing.disconnectSocket(socket.id));

  function register(eventName, update) {
    registerAcknowledgedEvent(socket, {
      eventName,
      ready,
      log,
      handle: async (payload) => {
        const command = parseTypingCommand(payload);

        limiter.consume();
        const context = await accessRepository.findAccessContext(command.conversationId, [
          socket.data.user.id,
        ]);
        requireConversationMember(context, socket.data.user.id);

        return { typing: update(command) };
      },
    });
  }
}

export function createTypingRateLimiter({ maxEvents = 12, windowMs = 2_000, now = Date.now } = {}) {
  let windowStartedAt = now();
  let eventCount = 0;

  return {
    consume() {
      const currentTime = now();

      if (currentTime - windowStartedAt >= windowMs) {
        windowStartedAt = currentTime;
        eventCount = 0;
      }

      eventCount += 1;

      if (eventCount > maxEvents) {
        throw new RateLimitError('Typing updates are too frequent');
      }
    },
  };
}

function parseTypingCommand(input) {
  const result = typingCommandSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new ValidationError(
    'Typing validation failed',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'typing',
      message: issue.message,
    })),
  );
}
