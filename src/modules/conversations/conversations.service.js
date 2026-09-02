import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { ValidationError } from '../../lib/errors.js';
import { conversationsRepository } from './conversations.repository.js';

const conversationListCursorSchema = z
  .object({
    id: z.uuid(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export function createConversationsService(repository) {
  return {
    async createDirect(creatorId, participantId) {
      if (creatorId === participantId) {
        throw new ValidationError('A direct conversation requires another user', [
          { field: 'userId', message: 'You cannot create a direct conversation with yourself' },
        ]);
      }

      const directKey = [creatorId, participantId].sort().join(':');
      const conversation = await repository.createOrGetDirect({
        creatorId,
        participantId,
        directKey,
      });

      return formatConversation(conversation);
    },

    async list(userId, { cursor: encodedCursor, limit }) {
      const parsedCursor = encodedCursor
        ? decodeCursor(encodedCursor, conversationListCursorSchema)
        : undefined;
      const cursor = parsedCursor
        ? { id: parsedCursor.id, updatedAt: new Date(parsedCursor.updatedAt) }
        : undefined;
      const result = await repository.listForUser({ userId, cursor, limit });
      const conversations = result.conversations.map((conversation) =>
        formatConversation(conversation, result.unreadCounts.get(conversation.id) ?? 0),
      );
      const lastConversation = result.conversations.at(-1);

      return {
        items: conversations,
        nextCursor:
          result.hasNextPage && lastConversation
            ? encodeCursor({
                id: lastConversation.id,
                updatedAt: lastConversation.updatedAt.toISOString(),
              })
            : null,
      };
    },
  };
}

function formatConversation(conversation, unreadCount) {
  const result = {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    imageUrl: conversation.imageUrl,
    createdById: conversation.createdById,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    members: conversation.members.map((member) => ({
      role: member.role,
      joinedAt: member.joinedAt,
      user: member.user,
    })),
    lastMessage: conversation.messages[0] ?? null,
  };

  if (unreadCount !== undefined) {
    result.unreadCount = unreadCount;
  }

  return result;
}

export const conversationsService = createConversationsService(conversationsRepository);
