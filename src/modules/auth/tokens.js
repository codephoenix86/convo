import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';

const ACCESS_TOKEN_ALGORITHM = 'HS256';
const REFRESH_TOKEN_BYTES = 32;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const accessTokenSecret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

const accessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  jti: z.uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.literal(env.JWT_ISSUER),
  aud: z.literal(env.JWT_AUDIENCE),
});

export async function signAccessToken({ userId, sessionId }) {
  const issuedAt = Math.floor(Date.now() / 1000);

  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + env.ACCESS_TOKEN_TTL_SECONDS)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .sign(accessTokenSecret);
}

export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, accessTokenSecret, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const claims = accessTokenPayloadSchema.parse(payload);

    return {
      userId: claims.sub,
      sessionId: claims.sid,
      tokenId: claims.jti,
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: new Date(claims.exp * 1000),
    };
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
}

export function generateRefreshToken() {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function getRefreshTokenExpiry(now = new Date()) {
  return new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * MILLISECONDS_PER_DAY);
}
