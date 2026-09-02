import { db } from '../../config/db.js';
import { ConflictError } from '../../lib/errors.js';

const profileSelect = Object.freeze({
  id: true,
  username: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
});

const searchResultSelect = Object.freeze({
  id: true,
  username: true,
  avatarUrl: true,
});

export function createUsersRepository(database = db) {
  return {
    findProfileById(userId) {
      return database.user.findUnique({
        where: { id: userId },
        select: profileSelect,
      });
    },

    async updateProfile(userId, changes) {
      try {
        return await database.user.update({
          where: { id: userId },
          data: changes,
          select: profileSelect,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError('Username is already in use');
        }

        throw error;
      }
    },

    search({ requestingUserId, query, cursor, limit }) {
      const cursorFilter = cursor
        ? [
            {
              OR: [
                { username: { gt: cursor.username } },
                { username: cursor.username, id: { gt: cursor.id } },
              ],
            },
          ]
        : [];

      return database.user.findMany({
        where: {
          id: { not: requestingUserId },
          AND: [{ username: { startsWith: query } }, ...cursorFilter],
        },
        orderBy: [{ username: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        select: searchResultSelect,
      });
    },
  };
}

function isUniqueConstraintError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2002';
}

export const usersRepository = createUsersRepository();
