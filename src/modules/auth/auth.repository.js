import { db } from '../../config/db.js';
import { ConflictError } from '../../lib/errors.js';

export function createAuthRepository(database = db) {
  return {
    async createUserWithSession({ user, session }) {
      try {
        return await database.$transaction(async (transaction) => {
          const createdUser = await transaction.user.create({ data: user });
          const createdSession = await transaction.refreshSession.create({
            data: {
              ...session,
              userId: createdUser.id,
            },
          });

          return { user: createdUser, session: createdSession };
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ConflictError('An account with that email or username already exists');
        }

        throw error;
      }
    },

    findUserByIdentifier(identifier) {
      const uniqueField = identifier.includes('@')
        ? { email: identifier }
        : { username: identifier };

      return database.user.findUnique({ where: uniqueField });
    },

    createSession(userId, session) {
      return database.refreshSession.create({
        data: {
          ...session,
          userId,
        },
      });
    },
  };
}

function isUniqueConstraintError(error) {
  return error !== null && typeof error === 'object' && error.code === 'P2002';
}

export const authRepository = createAuthRepository();
