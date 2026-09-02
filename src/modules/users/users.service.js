import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { usersRepository } from './users.repository.js';

const userSearchCursorSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1).max(32),
    query: z.string().min(2).max(64),
  })
  .strict();

export function createUsersService(repository) {
  return {
    async getProfile(userId) {
      const user = await repository.findProfileById(userId);

      if (!user) {
        throw new NotFoundError('User not found');
      }

      return user;
    },

    updateProfile(userId, changes) {
      return repository.updateProfile(userId, changes);
    },

    async search({ requestingUserId, query, cursor: encodedCursor, limit }) {
      const cursor = encodedCursor
        ? decodeCursor(encodedCursor, userSearchCursorSchema)
        : undefined;

      if (cursor && cursor.query !== query) {
        throw new ValidationError('Invalid pagination cursor', [
          { field: 'cursor', message: 'Cursor is invalid or does not match this request' },
        ]);
      }

      const rows = await repository.search({ requestingUserId, query, cursor, limit });
      const hasNextPage = rows.length > limit;
      const items = hasNextPage ? rows.slice(0, limit) : rows;
      const lastItem = items.at(-1);

      return {
        items,
        nextCursor:
          hasNextPage && lastItem
            ? encodeCursor({ id: lastItem.id, username: lastItem.username, query })
            : null,
      };
    },
  };
}

export const usersService = createUsersService(usersRepository);
