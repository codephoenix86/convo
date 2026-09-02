import { db } from '../../config/db.js';
import { NotFoundError } from '../../lib/errors.js';

const userSummarySelect = Object.freeze({
  id: true,
  username: true,
  avatarUrl: true,
});

const conversationInclude = Object.freeze({
  members: {
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: {
      role: true,
      joinedAt: true,
      lastReadAt: true,
      user: { select: userSummarySelect },
    },
  },
  messages: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      id: true,
      senderId: true,
      body: true,
      type: true,
      replyToId: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
    },
  },
});

export function createConversationsRepository(database = db) {
  return {
    createOrGetDirect({ creatorId, participantId, directKey }) {
      return database.$transaction(async (transaction) => {
        const participant = await transaction.user.findUnique({
          where: { id: participantId },
          select: { id: true },
        });

        if (!participant) {
          throw new NotFoundError('User not found');
        }

        return transaction.conversation.upsert({
          where: { directKey },
          update: {},
          create: {
            type: 'DIRECT',
            directKey,
            createdById: creatorId,
            members: {
              create: [
                { userId: creatorId, role: 'MEMBER' },
                { userId: participantId, role: 'MEMBER' },
              ],
            },
          },
          include: conversationInclude,
        });
      });
    },

    async listForUser({ userId, cursor, limit }) {
      const cursorFilter = cursor
        ? {
            OR: [
              { updatedAt: { lt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
            ],
          }
        : {};
      const rows = await database.conversation.findMany({
        where: {
          members: { some: { userId } },
          ...cursorFilter,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: conversationInclude,
      });
      const hasNextPage = rows.length > limit;
      const conversations = hasNextPage ? rows.slice(0, limit) : rows;

      if (conversations.length === 0) {
        return { conversations, hasNextPage, unreadCounts: new Map() };
      }

      const unreadGroups = await database.message.groupBy({
        by: ['conversationId'],
        where: {
          senderId: { not: userId },
          deletedAt: null,
          OR: conversations.map((conversation) => {
            const membership = conversation.members.find((member) => member.user.id === userId);

            return {
              conversationId: conversation.id,
              createdAt: { gt: membership.lastReadAt ?? membership.joinedAt },
            };
          }),
        },
        _count: { _all: true },
      });
      const unreadCounts = new Map(
        unreadGroups.map((group) => [group.conversationId, group._count._all]),
      );

      return { conversations, hasNextPage, unreadCounts };
    },
  };
}

export const conversationsRepository = createConversationsRepository();
