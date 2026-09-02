import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../../src/lib/errors.js';
import { createUsersRepository } from '../../src/modules/users/users.repository.js';

describe('users repository', () => {
  it('maps a duplicate username to a conflict without exposing database details', async () => {
    const database = {
      user: { update: vi.fn().mockRejectedValue({ code: 'P2002', detail: 'sensitive' }) },
    };
    const repository = createUsersRepository(database);

    await expect(repository.updateProfile('user-id', { username: 'taken' })).rejects.toEqual(
      expect.objectContaining({
        name: ConflictError.name,
        message: 'Username is already in use',
      }),
    );
  });

  it('uses stable ordering, excludes the requester, and fetches only one lookahead row', async () => {
    const database = { user: { findMany: vi.fn().mockResolvedValue([]) } };
    const repository = createUsersRepository(database);

    await repository.search({
      requestingUserId: 'requesting-user',
      query: 'per',
      cursor: { id: 'cursor-id', username: 'person' },
      limit: 20,
    });

    expect(database.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { not: 'requesting-user' },
        AND: [
          { username: { startsWith: 'per' } },
          {
            OR: [{ username: { gt: 'person' } }, { username: 'person', id: { gt: 'cursor-id' } }],
          },
        ],
      },
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
      take: 21,
      select: { id: true, username: true, avatarUrl: true },
    });
  });
});
