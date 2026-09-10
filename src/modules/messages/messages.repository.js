import { db } from '../../config/db.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

const attachmentSelect = Object.freeze({
  id: true,
  storageKey: true,
  mimeType: true,
  size: true,
  width: true,
  height: true,
  createdAt: true,
});

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
  attachments: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: attachmentSelect,
  },
});
const receiptPositions = Object.freeze({
  delivered: Object.freeze({
    messageId: 'lastDeliveredMessageId',
    timestamp: 'lastDeliveredAt',
  }),
  read: Object.freeze({
    messageId: 'lastReadMessageId',
    timestamp: 'lastReadAt',
  }),
});

export function createMessagesRepository(database = db) {
  return {
    async create({ conversationId, senderId, clientMessageId, body, replyToId, attachments = [] }) {
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
                ...(attachments.length
                  ? {
                      attachments: {
                        create: attachments,
                      },
                    }
                  : {}),
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

          throw new ConflictError('An attachment has already been used');
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

    findMutationContext({ messageId, userId }) {
      return database.message.findFirst({
        where: {
          id: messageId,
          conversation: { members: { some: { userId } } },
        },
        select: messageSelect,
      });
    },

    async edit({ conversationId, messageId, userId, body }) {
      try {
        const result = await database.conversation.update({
          where: {
            id: conversationId,
            members: { some: { userId } },
          },
          data: {
            updatedAt: new Date(),
            messages: {
              update: {
                where: {
                  id: messageId,
                  senderId: userId,
                  type: 'TEXT',
                  deletedAt: null,
                },
                data: { body, editedAt: new Date() },
              },
            },
          },
          select: {
            messages: {
              where: { id: messageId },
              select: messageSelect,
            },
          },
        });

        return result.messages[0];
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Message not found');
        }

        throw error;
      }
    },

    async softDelete({ conversationId, messageId, userId }) {
      try {
        const result = await database.conversation.update({
          where: {
            id: conversationId,
            members: { some: { userId } },
          },
          data: {
            updatedAt: new Date(),
            messages: {
              update: {
                where: {
                  id: messageId,
                  senderId: userId,
                  type: 'TEXT',
                  deletedAt: null,
                },
                data: { deletedAt: new Date() },
              },
            },
          },
          select: {
            messages: {
              where: { id: messageId },
              select: messageSelect,
            },
          },
        });

        return result.messages[0];
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Message not found');
        }

        throw error;
      }
    },

    advanceDeliveredPosition({ conversationId, userId, messageId }) {
      return advanceReceiptPositions(database, {
        conversationId,
        userId,
        messageId,
        positions: ['delivered'],
        primaryPosition: 'delivered',
      });
    },

    advanceReadPosition({ conversationId, userId, messageId }) {
      return advanceReceiptPositions(database, {
        conversationId,
        userId,
        messageId,
        positions: ['delivered', 'read'],
        primaryPosition: 'read',
      });
    },
  };
}

function advanceReceiptPositions(
  database,
  { conversationId, userId, messageId, positions, primaryPosition },
) {
  return database.$transaction(async (transaction) => {
    const targetMessage = await transaction.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, createdAt: true },
    });

    if (!targetMessage) {
      throw new NotFoundError('Message not found');
    }

    const updateCounts = new Map();

    for (const position of positions) {
      const fields = receiptPositions[position];
      const update = await transaction.conversationMember.updateMany({
        where: {
          conversationId,
          userId,
          OR: [
            { [fields.timestamp]: null },
            { [fields.timestamp]: { lt: targetMessage.createdAt } },
            {
              [fields.timestamp]: targetMessage.createdAt,
              [fields.messageId]: { lt: targetMessage.id },
            },
          ],
        },
        data: {
          [fields.messageId]: targetMessage.id,
          [fields.timestamp]: targetMessage.createdAt,
        },
      });

      updateCounts.set(position, update.count);
    }

    const selectedFields = Object.fromEntries(
      positions.flatMap((position) => {
        const fields = receiptPositions[position];

        return [
          [fields.messageId, true],
          [fields.timestamp, true],
        ];
      }),
    );
    const membership = await transaction.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
      select: {
        conversationId: true,
        userId: true,
        ...selectedFields,
      },
    });

    if (!membership) {
      throw new NotFoundError('Conversation not found');
    }

    const primaryFields = receiptPositions[primaryPosition];

    return {
      receipt: {
        conversationId: membership.conversationId,
        userId: membership.userId,
        [primaryFields.messageId]: membership[primaryFields.messageId],
        [primaryFields.timestamp]: membership[primaryFields.timestamp],
      },
      advanced: updateCounts.get(primaryPosition) === 1,
    };
  });
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
