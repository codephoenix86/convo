import { db } from '../../config/db.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

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
      clientMessageId: true,
      createdAt: true,
      updatedAt: true,
      editedAt: true,
      deletedAt: true,
    },
  },
});

export function createConversationsRepository(database = db) {
  return {
    findAccessContext(conversationId, userIds) {
      return database.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          type: true,
          members: {
            where: { userId: { in: [...new Set(userIds)] } },
            select: { userId: true, role: true },
          },
        },
      });
    },

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

    createGroup({ creatorId, name, imageUrl, memberIds }) {
      return database.$transaction(async (transaction) => {
        const existingMembers = await transaction.user.findMany({
          where: { id: { in: memberIds } },
          select: { id: true },
        });

        if (existingMembers.length !== memberIds.length) {
          throw new NotFoundError('One or more users were not found');
        }

        return transaction.conversation.create({
          data: {
            type: 'GROUP',
            name,
            imageUrl,
            createdById: creatorId,
            members: {
              create: [
                { userId: creatorId, role: 'OWNER' },
                ...memberIds.map((userId) => ({ userId, role: 'MEMBER' })),
              ],
            },
          },
          include: conversationInclude,
        });
      });
    },

    async updateGroup({ conversationId, actorId, changes }) {
      try {
        return await database.conversation.update({
          where: {
            id: conversationId,
            type: 'GROUP',
            members: {
              some: {
                userId: actorId,
                role: { in: ['OWNER', 'ADMIN'] },
              },
            },
          },
          data: changes,
          include: conversationInclude,
        });
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Conversation not found');
        }

        throw error;
      }
    },

    async addGroupMember({ conversationId, actorId, actorRoles, userId, role }) {
      try {
        return await database.$transaction(async (transaction) => {
          const user = await transaction.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });

          if (!user) {
            throw new NotFoundError('User not found');
          }

          return transaction.conversation.update({
            where: {
              id: conversationId,
              type: 'GROUP',
              members: {
                some: { userId: actorId, role: { in: actorRoles } },
              },
            },
            data: {
              members: { create: { userId, role } },
            },
            include: conversationInclude,
          });
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError('User is already a conversation member');
        }

        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Conversation not found');
        }

        throw error;
      }
    },

    async removeGroupMember({ conversationId, actorId, actorRoles, userId, targetRole }) {
      try {
        return await database.conversation.update({
          where: {
            id: conversationId,
            type: 'GROUP',
            AND: [
              { members: { some: { userId: actorId, role: { in: actorRoles } } } },
              { members: { some: { userId, role: targetRole } } },
            ],
          },
          data: {
            members: {
              delete: { conversationId_userId: { conversationId, userId } },
            },
          },
          include: conversationInclude,
        });
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Conversation member not found');
        }

        throw error;
      }
    },

    async updateGroupMemberRole({
      conversationId,
      actorId,
      actorRoles,
      userId,
      currentRole,
      role,
    }) {
      try {
        return await database.conversation.update({
          where: {
            id: conversationId,
            type: 'GROUP',
            AND: [
              { members: { some: { userId: actorId, role: { in: actorRoles } } } },
              { members: { some: { userId, role: currentRole } } },
            ],
          },
          data: {
            members: {
              update: {
                where: { conversationId_userId: { conversationId, userId } },
                data: { role },
              },
            },
          },
          include: conversationInclude,
        });
      } catch (error) {
        if (isRecordNotFoundError(error)) {
          throw new NotFoundError('Conversation member not found');
        }

        throw error;
      }
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

function isRecordNotFoundError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2025';
}

function isUniqueConstraintError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2002';
}

export const conversationsRepository = createConversationsRepository();
