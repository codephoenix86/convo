import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../../src/lib/errors.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';

const now = new Date('2026-09-01T12:00:00.000Z');

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

  it('atomically revokes a refresh session before creating its replacement', async () => {
    const currentSession = {
      id: 'current-session',
      userId: 'user-id',
      tokenHash: 'old-hash',
      revokedAt: null,
      expiresAt: new Date('2026-09-02T12:00:00.000Z'),
      user: { id: 'user-id' },
    };
    const replacementSession = { id: 'replacement-session', tokenHash: 'new-hash' };
    const transaction = {
      refreshSession: {
        findUnique: vi.fn().mockResolvedValue(currentSession),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue(replacementSession),
      },
    };
    const database = {
      $transaction: vi.fn((operation) => operation(transaction)),
    };
    const repository = createAuthRepository(database);

    const result = await repository.rotateSession({
      currentTokenHash: 'old-hash',
      replacementSession,
      rotatedAt: now,
    });

    expect(transaction.refreshSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: currentSession.id,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    expect(transaction.refreshSession.create).toHaveBeenCalledWith({
      data: { ...replacementSession, userId: currentSession.userId },
    });
    expect(result).toEqual({ user: currentSession.user, session: replacementSession });
  });

  it('rejects an expired or revoked refresh session without creating a replacement', async () => {
    const transaction = {
      refreshSession: {
        findUnique: vi.fn().mockResolvedValue({
          revokedAt: now,
          expiresAt: new Date('2026-09-02T12:00:00.000Z'),
        }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createAuthRepository(database);

    const result = await repository.rotateSession({
      currentTokenHash: 'old-hash',
      replacementSession: {},
      rotatedAt: now,
    });

    expect(result).toBeNull();
    expect(transaction.refreshSession.updateMany).not.toHaveBeenCalled();
    expect(transaction.refreshSession.create).not.toHaveBeenCalled();
  });

  it('allows only one winner when refresh rotation requests race', async () => {
    const transaction = {
      refreshSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'current-session',
          revokedAt: null,
          expiresAt: new Date('2026-09-02T12:00:00.000Z'),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(),
      },
    };
    const database = { $transaction: vi.fn((operation) => operation(transaction)) };
    const repository = createAuthRepository(database);

    const result = await repository.rotateSession({
      currentTokenHash: 'old-hash',
      replacementSession: {},
      rotatedAt: now,
    });

    expect(result).toBeNull();
    expect(transaction.refreshSession.create).not.toHaveBeenCalled();
  });
});
