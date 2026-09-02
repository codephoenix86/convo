import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '../../src/lib/cursor.js';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { createUsersService } from '../../src/modules/users/users.service.js';

const requestingUserId = randomUUID();

function createRepository() {
  return {
    findProfileById: vi.fn(),
    updateProfile: vi.fn(),
    search: vi.fn(),
  };
}

describe('users service', () => {
  it('returns the authenticated profile without transforming its safe projection', async () => {
    const repository = createRepository();
    const profile = { id: requestingUserId, username: 'person', email: 'person@example.com' };
    repository.findProfileById.mockResolvedValue(profile);
    const service = createUsersService(repository);

    await expect(service.getProfile(requestingUserId)).resolves.toBe(profile);
  });

  it('rejects an access token whose user no longer exists', async () => {
    const repository = createRepository();
    repository.findProfileById.mockResolvedValue(null);
    const service = createUsersService(repository);

    await expect(service.getProfile(requestingUserId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns a bounded page and a query-bound cursor when another row exists', async () => {
    const repository = createRepository();
    const rows = ['amy', 'ben', 'cal'].map((username) => ({ id: randomUUID(), username }));
    repository.search.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    const service = createUsersService(repository);

    const firstPage = await service.search({
      requestingUserId,
      query: 'am',
      limit: 2,
    });

    expect(firstPage.items).toEqual(rows.slice(0, 2));
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await service.search({
      requestingUserId,
      query: 'am',
      cursor: firstPage.nextCursor,
      limit: 2,
    });

    expect(repository.search).toHaveBeenLastCalledWith({
      requestingUserId,
      query: 'am',
      cursor: { id: rows[1].id, username: 'ben', query: 'am' },
      limit: 2,
    });
  });

  it('rejects a cursor created for a different search query', async () => {
    const repository = createRepository();
    const service = createUsersService(repository);
    const cursor = encodeCursor({ id: randomUUID(), username: 'ben', query: 'be' });

    await expect(
      service.search({ requestingUserId, query: 'ca', cursor, limit: 20 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.search).not.toHaveBeenCalled();
  });
});
