import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../src/lib/errors.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';

const sessionId = randomUUID();
const userId = randomUUID();
const now = new Date('2026-09-01T12:00:00.000Z');
const expiresAt = new Date('2026-10-01T12:00:00.000Z');

function createFixture() {
  const repository = {
    createUserWithSession: vi.fn(),
    findUserByIdentifier: vi.fn(),
    createSession: vi.fn(),
  };
  const passwordHasher = vi.fn().mockResolvedValue('stored-password-hash');
  const passwordVerifier = vi.fn();
  const tokenManager = {
    generateRefreshToken: vi.fn().mockReturnValue('raw-refresh-token'),
    hashRefreshToken: vi.fn().mockReturnValue('a'.repeat(64)),
    getRefreshTokenExpiry: vi.fn().mockReturnValue(expiresAt),
    signAccessToken: vi.fn().mockResolvedValue('signed-access-token'),
  };
  const service = createAuthService({
    repository,
    passwordHasher,
    passwordVerifier,
    tokenManager,
    sessionIdGenerator: () => sessionId,
  });

  return { repository, passwordHasher, passwordVerifier, tokenManager, service };
}

function createStoredUser(overrides = {}) {
  return {
    id: userId,
    email: 'person@example.com',
    username: 'person',
    passwordHash: 'stored-password-hash',
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('auth service registration', () => {
  it('hashes the password and creates the user and refresh session atomically', async () => {
    const fixture = createFixture();
    const storedUser = createStoredUser();
    fixture.repository.createUserWithSession.mockResolvedValue({
      user: storedUser,
      session: { id: sessionId },
    });

    const result = await fixture.service.register(
      {
        email: storedUser.email,
        username: storedUser.username,
        password: 'Secure-password1!',
      },
      { ipAddress: '127.0.0.1', userAgent: 'test-client' },
    );

    expect(fixture.passwordHasher).toHaveBeenCalledWith('Secure-password1!');
    expect(fixture.repository.createUserWithSession).toHaveBeenCalledWith({
      user: {
        email: storedUser.email,
        username: storedUser.username,
        passwordHash: 'stored-password-hash',
      },
      session: {
        id: sessionId,
        tokenHash: 'a'.repeat(64),
        expiresAt,
        ipAddress: '127.0.0.1',
        userAgent: 'test-client',
      },
    });
    expect(fixture.tokenManager.signAccessToken).toHaveBeenCalledWith({ userId, sessionId });
    expect(result).toEqual({
      user: {
        id: userId,
        email: storedUser.email,
        username: storedUser.username,
        avatarUrl: null,
        createdAt: now,
        updatedAt: now,
      },
      tokens: {
        accessToken: 'signed-access-token',
        refreshToken: 'raw-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      },
    });
    expect(result.user).not.toHaveProperty('passwordHash');
  });
});

describe('auth service login', () => {
  let fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  it('verifies credentials and creates a new refresh session', async () => {
    const storedUser = createStoredUser();
    fixture.repository.findUserByIdentifier.mockResolvedValue(storedUser);
    fixture.passwordVerifier.mockResolvedValue(true);
    fixture.repository.createSession.mockResolvedValue({ id: sessionId });

    const result = await fixture.service.login(
      { identifier: storedUser.email, password: 'Secure-password1!' },
      { ipAddress: '127.0.0.1', userAgent: 'test-client' },
    );

    expect(fixture.passwordVerifier).toHaveBeenCalledWith(
      storedUser.passwordHash,
      'Secure-password1!',
    );
    expect(fixture.repository.createSession).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ id: sessionId, tokenHash: 'a'.repeat(64), expiresAt }),
    );
    expect(result.tokens.refreshToken).toBe('raw-refresh-token');
  });

  it('returns the same generic error for an unknown account', async () => {
    fixture.repository.findUserByIdentifier.mockResolvedValue(null);
    fixture.passwordVerifier.mockResolvedValue(false);

    await expect(
      fixture.service.login({ identifier: 'missing@example.com', password: 'wrong-password' }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: UnauthorizedError.name,
        code: 'UNAUTHORIZED',
        message: 'Invalid email, username, or password',
      }),
    );

    expect(fixture.passwordVerifier).toHaveBeenCalledWith(
      expect.stringMatching(/^\$argon2id\$/),
      'wrong-password',
    );
    expect(fixture.repository.createSession).not.toHaveBeenCalled();
  });

  it('returns the same generic error for an incorrect password', async () => {
    fixture.repository.findUserByIdentifier.mockResolvedValue(createStoredUser());
    fixture.passwordVerifier.mockResolvedValue(false);

    await expect(
      fixture.service.login({ identifier: 'person', password: 'wrong-password' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid email, username, or password',
    });

    expect(fixture.repository.createSession).not.toHaveBeenCalled();
  });
});
