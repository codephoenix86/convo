import { db } from '../../config/db.js';
import { NotFoundError } from '../../lib/errors.js';

const messageSelect = Object.freeze({
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  body: true,
  type: true,
  replyToId: true,
  createdAt: true,
  updatedAt: true,
  editedAt: true,
  deletedAt: true,
  sender: {
    select: {
      id: true,
      username: true,
      avatarUrl: true,
    },
  },
});

export function createMessagesRepository(database = db) {
  return {
    async create({ conversationId, senderId, clientMessageId, body, replyToId }) {
      try {
        const result = await database.conversation.update({
          where: {
            id: conversationId,
            members: { some: { userId: senderId } },
          },
          data: {
            updatedAt: new Date(),
            messages: {
              create: {
                senderId,
                clientMessageId,
                body,
                type: 'TEXT',
                replyToId: replyToId ?? null,
              },
            },
          },
          select: {
            messages: {
              where: { senderId, clientMessageId },
              take: 1,
              select: messageSelect,
            },
          },
        });

        return { message: result.messages[0], created: true };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const message = await database.message.findFirst({
            where: {
              conversationId,
              senderId,
              clientMessageId,
              conversation: { members: { some: { userId: senderId } } },
            },
            select: messageSelect,
          });

          if (message) {
            return { message, created: false };
          }
        }

        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Conversation not found');
        }

        if (isForeignKeyError(error)) {
          throw new NotFoundError('Reply message not found');
        }

        throw error;
      }
    },

    listHistory({ conversationId, userId, cursor, limit }) {
      const cursorFilter = cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {};

      return database.message.findMany({
        where: {
          conversationId,
          conversation: { members: { some: { userId } } },
          ...cursorFilter,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: messageSelect,
      });
    },

    async advanceReadPosition({ conversationId, userId, messageId }) {
      const targetMessage = await database.message.findFirst({
        where: { id: messageId, conversationId },
        select: { id: true, createdAt: true },
      });

      if (!targetMessage) {
        throw new NotFoundError('Message not found');
      }

      await database.conversationMember.updateMany({
        where: {
          conversationId,
          userId,
          OR: [
            { lastReadAt: null },
            { lastReadAt: { lt: targetMessage.createdAt } },
            {
              lastReadAt: targetMessage.createdAt,
              lastReadMessageId: { lt: targetMessage.id },
            },
          ],
        },
        data: {
          lastReadMessageId: targetMessage.id,
          lastReadAt: targetMessage.createdAt,
        },
      });

      const membership = await database.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: {
          conversationId: true,
          userId: true,
          lastReadMessageId: true,
          lastReadAt: true,
        },
      });

      if (!membership) {
        throw new NotFoundError('Conversation not found');
      }

      return membership;
    },
  };
}

function isUniqueConstraintError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2002';
}

function isRecordNotFoundError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2025';
}

function isForeignKeyError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2003';
}

export const messagesRepository = createMessagesRepository();
