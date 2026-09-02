import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../src/lib/errors.js';
import {
  generateRefreshToken,
  getRefreshTokenExpiry,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/modules/auth/tokens.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('access tokens', () => {
  it('round-trips authenticated user and session claims', async () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const userId = randomUUID();
    const sessionId = randomUUID();
    vi.setSystemTime(now);

    const token = await signAccessToken({ userId, sessionId });
    const claims = await verifyAccessToken(token);

    expect(claims).toMatchObject({
      userId,
      sessionId,
      issuedAt: now,
      expiresAt: new Date('2026-09-01T12:15:00.000Z'),
    });
    expect(claims.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects tampered access tokens with a generic auth error', async () => {
    const token = await signAccessToken({ userId: randomUUID(), sessionId: randomUUID() });
    const [header, payload, signature] = token.split('.');
    const tamperedSignature = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    await expect(verifyAccessToken(tamperedToken)).rejects.toEqual(
      expect.objectContaining({
        name: UnauthorizedError.name,
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired access token',
      }),
    );
  });

  it('rejects expired access tokens', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const token = await signAccessToken({ userId: randomUUID(), sessionId: randomUUID() });
    vi.setSystemTime(new Date('2026-09-01T12:15:01.000Z'));

    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('refresh tokens', () => {
  it('generates high-entropy opaque values and stores only deterministic hashes', () => {
    const firstToken = generateRefreshToken();
    const secondToken = generateRefreshToken();

    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).not.toBe(firstToken);
    expect(hashRefreshToken(firstToken)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRefreshToken(firstToken)).toBe(hashRefreshToken(firstToken));
    expect(hashRefreshToken(firstToken)).not.toBe(hashRefreshToken(secondToken));
  });

  it('calculates refresh expiry from configuration without mutating the input date', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');

    const expiresAt = getRefreshTokenExpiry(now);

    expect(expiresAt).toEqual(new Date('2026-10-01T12:00:00.000Z'));
    expect(now).toEqual(new Date('2026-09-01T12:00:00.000Z'));
  });
});
