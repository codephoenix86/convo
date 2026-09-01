import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../../src/lib/errors.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';

describe('auth repository', () => {
  it('maps database uniqueness violations to a public account conflict', async () => {
    const database = {
      $transaction: vi.fn().mockRejectedValue({ code: 'P2002' }),
    };
    const repository = createAuthRepository(database);

    await expect(
      repository.createUserWithSession({ user: {}, session: {} }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it.each([
    ['person@example.com', { email: 'person@example.com' }],
    ['person_name', { username: 'person_name' }],
  ])('uses an indexed unique lookup for %s', async (identifier, where) => {
    const database = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const repository = createAuthRepository(database);

    await repository.findUserByIdentifier(identifier);

    expect(database.user.findUnique).toHaveBeenCalledWith({ where });
  });
});
