import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { requireConversationMember } from '../conversations/conversation-access.js';
import { conversationsRepository } from '../conversations/conversations.repository.js';
import { presentMessage } from './message-presenter.js';
import { messagesRepository } from './messages.repository.js';
import {
  deleteMessageCommandSchema,
  editMessageCommandSchema,
  markConversationReadCommandSchema,
  markMessageDeliveredCommandSchema,
  sendMessageCommandSchema,
} from './messages.validation.js';

const messageHistoryCursorSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();
const noOpMessageEvents = Object.freeze({
  async messageCreated() {},
  async messageDelivered() {},
  async conversationRead() {},
  async messageEdited() {},
  async messageDeleted() {},
});

export function createMessagesService({
  repository,
  accessRepository,
  messageEvents = noOpMessageEvents,
}) {
  return {
    async send(userId, input) {
      const command = parseSendMessageCommand(input);
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);

      const result = await repository.create({
        conversationId: command.conversationId,
        senderId: userId,
        clientMessageId: command.clientMessageId,
        body: command.body,
        replyToId: command.replyToId ?? null,
      });

      if (result.created) {
        await messageEvents.messageCreated({ message: result.message });
      }

      return result;
    },

    async listHistory(userId, conversationId, { cursor: encodedCursor, limit }) {
      const context = await accessRepository.findAccessContext(conversationId, [userId]);
      requireConversationMember(context, userId);
      const parsedCursor = encodedCursor
        ? decodeCursor(encodedCursor, messageHistoryCursorSchema)
        : undefined;

      if (parsedCursor && parsedCursor.conversationId !== conversationId) {
        throw new ValidationError('Invalid pagination cursor', [
          { field: 'cursor', message: 'Cursor is invalid or does not match this request' },
        ]);
      }

      const cursor = parsedCursor
        ? { id: parsedCursor.id, createdAt: new Date(parsedCursor.createdAt) }
        : undefined;
      const rows = await repository.listHistory({ conversationId, userId, cursor, limit });
      const hasNextPage = rows.length > limit;
      const messages = (hasNextPage ? rows.slice(0, limit) : rows).map(presentMessage);
      const lastMessage = messages.at(-1);

      return {
        items: messages,
        nextCursor:
          hasNextPage && lastMessage
            ? encodeCursor({
                id: lastMessage.id,
                conversationId,
                createdAt: lastMessage.createdAt.toISOString(),
              })
            : null,
      };
    },

    async markRead(userId, input) {
      const command = parseCommand(markConversationReadCommandSchema, input, 'Read state');
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);
      const result = await repository.advanceReadPosition({
        conversationId: command.conversationId,
        userId,
        messageId: command.messageId,
      });

      if (result.advanced) {
        await messageEvents.conversationRead({ receipt: result.receipt });
      }

      return result.receipt;
    },

    async markDelivered(userId, input) {
      const command = parseCommand(markMessageDeliveredCommandSchema, input, 'Delivery receipt');
      const context = await accessRepository.findAccessContext(command.conversationId, [userId]);
      requireConversationMember(context, userId);
      const result = await repository.advanceDeliveredPosition({
        conversationId: command.conversationId,
        userId,
        messageId: command.messageId,
      });

      if (result.advanced) {
        await messageEvents.messageDelivered({ receipt: result.receipt });
      }

      return result.receipt;
    },

    async edit(userId, input) {
      const command = parseCommand(editMessageCommandSchema, input, 'Message');
      const context = await repository.findMutationContext({
        messageId: command.messageId,
        userId,
      });
      requireSenderMutation(context, userId);

      if (context.deletedAt) {
        throw new ConflictError('Deleted messages cannot be edited');
      }

      if (context.type !== 'TEXT') {
        throw new ConflictError('This message type cannot be edited');
      }

      if (context.body === command.body) {
        return presentMessage(context);
      }

      const message = presentMessage(
        await repository.edit({
          conversationId: context.conversationId,
          messageId: command.messageId,
          userId,
          body: command.body,
        }),
      );

      await messageEvents.messageEdited({ message });

      return message;
    },

    async delete(userId, input) {
      const command = parseCommand(deleteMessageCommandSchema, input, 'Message');
      const context = await repository.findMutationContext({
        messageId: command.messageId,
        userId,
      });
      requireSenderMutation(context, userId);

      if (context.deletedAt) {
        return presentMessage(context);
      }

      if (context.type !== 'TEXT') {
        throw new ConflictError('This message type cannot be deleted');
      }

      const message = presentMessage(
        await repository.softDelete({
          conversationId: context.conversationId,
          messageId: command.messageId,
          userId,
        }),
      );

      await messageEvents.messageDeleted({ message });

      return message;
    },
  };
}

function requireSenderMutation(message, userId) {
  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.senderId !== userId) {
    throw new ForbiddenError('Only the message sender can modify it');
  }
}

function parseSendMessageCommand(input) {
  return parseCommand(sendMessageCommandSchema, input, 'Message');
}

function parseCommand(schema, input, subject) {
  const result = schema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new ValidationError(
    `${subject} validation failed`,
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'message',
      message: issue.message,
    })),
  );
}

export const messagesService = createMessagesService({
  repository: messagesRepository,
  accessRepository: conversationsRepository,
});
