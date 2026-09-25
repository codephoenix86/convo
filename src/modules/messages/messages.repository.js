import { randomUUID } from 'node:crypto';

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
        if (attachments.length === 0) {
          return await createTextMessage(database, {
            conversationId,
            senderId,
            clientMessageId,
            body,
            replyToId: replyToId ?? null,
          });
        }

        const message = await createAttachmentMessage(database, {
          conversationId,
          senderId,
          clientMessageId,
          body,
          replyToId: replyToId ?? null,
          attachments,
        });

        return { message, created: true };
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

async function createTextMessage(
  database,
  { conversationId, senderId, clientMessageId, body, replyToId },
) {
  const candidateMessageId = randomUUID();
  const rows = await database.$queryRaw`
    WITH "authorized_member" AS MATERIALIZED (
      SELECT "conversation_id"
      FROM "public"."conversation_members"
      WHERE "conversation_id" = ${conversationId}::uuid
        AND "user_id" = ${senderId}::uuid
      FOR KEY SHARE
    ),
    "canonical_message" AS (
      INSERT INTO "public"."messages" (
        "id",
        "conversation_id",
        "sender_id",
        "client_message_id",
        "body",
        "type",
        "reply_to_id",
        "created_at",
        "updated_at"
      )
      SELECT
        ${candidateMessageId}::uuid,
        "authorized_member"."conversation_id",
        ${senderId}::uuid,
        ${clientMessageId}::uuid,
        ${body},
        'TEXT'::"public"."MessageType",
        ${replyToId}::uuid,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "authorized_member"
      ON CONFLICT ("sender_id", "conversation_id", "client_message_id")
      DO UPDATE SET "client_message_id" = EXCLUDED."client_message_id"
      RETURNING
        "id",
        "conversation_id",
        "sender_id",
        "client_message_id",
        "body",
        "type",
        "reply_to_id",
        "created_at",
        "updated_at",
        "edited_at",
        "deleted_at"
    ),
    "bumped_conversation" AS (
      UPDATE "public"."conversations"
      SET "updated_at" = "canonical_message"."created_at"
      FROM "canonical_message"
      WHERE "conversations"."id" = "canonical_message"."conversation_id"
        AND "canonical_message"."id" = ${candidateMessageId}::uuid
      RETURNING "conversations"."id"
    )
    SELECT
      "canonical_message"."id",
      "canonical_message"."conversation_id" AS "conversationId",
      "canonical_message"."sender_id" AS "senderId",
      "canonical_message"."client_message_id" AS "clientMessageId",
      "canonical_message"."body",
      "canonical_message"."type"::text AS "type",
      "canonical_message"."reply_to_id" AS "replyToId",
      "canonical_message"."created_at" AS "createdAt",
      "canonical_message"."updated_at" AS "updatedAt",
      "canonical_message"."edited_at" AS "editedAt",
      "canonical_message"."deleted_at" AS "deletedAt",
      "users"."username" AS "senderUsername",
      "users"."avatar_url" AS "senderAvatarUrl",
      ("canonical_message"."id" = ${candidateMessageId}::uuid) AS "created"
    FROM "canonical_message"
    INNER JOIN "public"."users"
      ON "users"."id" = "canonical_message"."sender_id"
  `;
  const row = rows[0];

  if (!row) {
    throw new NotFoundError('Conversation not found');
  }

  return {
    message: {
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      clientMessageId: row.clientMessageId,
      body: row.body,
      type: row.type,
      replyToId: row.replyToId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      sender: {
        id: row.senderId,
        username: row.senderUsername,
        avatarUrl: row.senderAvatarUrl,
      },
      attachments: [],
    },
    created: row.created,
  };
}

function createAttachmentMessage(
  database,
  { conversationId, senderId, clientMessageId, body, replyToId, attachments },
) {
  return database.$transaction(async (transaction) => {
    const memberships = await transaction.$queryRaw`
      SELECT "conversation_id"
      FROM "public"."conversation_members"
      WHERE "conversation_id" = ${conversationId}::uuid
        AND "user_id" = ${senderId}::uuid
      FOR KEY SHARE
    `;

    if (memberships.length === 0) {
      throw new NotFoundError('Conversation not found');
    }

    const result = await transaction.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        messages: {
          create: {
            senderId,
            clientMessageId,
            body,
            type: 'TEXT',
            replyToId,
            attachments: { create: attachments },
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

    return result.messages[0];
  });
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
  if (error === null || typeof error !== 'object') {
    return false;
  }

  return (
    error.code === 'P2003' ||
    error.code === '23503' ||
    (error.code === 'P2010' && error.meta?.driverAdapterError?.cause?.originalCode === '23503')
  );
}

export const messagesRepository = createMessagesRepository();
