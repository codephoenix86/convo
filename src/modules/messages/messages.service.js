import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { ValidationError } from '../../lib/errors.js';
import { requireConversationMember } from '../conversations/conversation-access.js';
import { conversationsRepository } from '../conversations/conversations.repository.js';
import { messagesRepository } from './messages.repository.js';

const messageHistoryCursorSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

export function createMessagesService({ repository, accessRepository }) {
  return {
    async create(userId, conversationId, input) {
      const context = await accessRepository.findAccessContext(conversationId, [userId]);
      requireConversationMember(context, userId);

      return repository.create({
        conversationId,
        senderId: userId,
        clientMessageId: input.clientMessageId,
        body: input.body,
        replyToId: input.replyToId ?? null,
      });
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
      const messages = hasNextPage ? rows.slice(0, limit) : rows;
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
  };
}

export const messagesService = createMessagesService({
  repository: messagesRepository,
  accessRepository: conversationsRepository,
});
