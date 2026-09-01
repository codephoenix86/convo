import { randomUUID } from 'node:crypto';

import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { authRepository } from './auth.repository.js';
import {
  generateRefreshToken,
  getRefreshTokenExpiry,
  hashRefreshToken,
  signAccessToken,
} from './tokens.js';

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$Lu+XRZXMQPTI5BbhXWmcPg$EjuyZ9XGBTIFex1dVAtTxsNRNI9CFFeGIrtNEbtjspg';

const defaultTokenManager = Object.freeze({
  generateRefreshToken,
  getRefreshTokenExpiry,
  hashRefreshToken,
  signAccessToken,
});

export function createAuthService({
  repository,
  passwordHasher = hashPassword,
  passwordVerifier = verifyPassword,
  tokenManager = defaultTokenManager,
  sessionIdGenerator = randomUUID,
}) {
  async function register({ email, username, password }, metadata = {}) {
    const passwordHash = await passwordHasher(password);
    const sessionDraft = createSessionDraft(metadata);
    const result = await repository.createUserWithSession({
      user: { email, username, passwordHash },
      session: sessionDraft.storedSession,
    });

    return buildAuthenticationResult(result.user, result.session.id, sessionDraft.refreshToken);
  }

  async function login({ identifier, password }, metadata = {}) {
    const user = await repository.findUserByIdentifier(identifier);
    const passwordMatches = await passwordVerifier(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      password,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedError('Invalid email, username, or password');
    }

    const sessionDraft = createSessionDraft(metadata);
    const session = await repository.createSession(user.id, sessionDraft.storedSession);

    return buildAuthenticationResult(user, session.id, sessionDraft.refreshToken);
  }

  async function refresh({ refreshToken }, metadata = {}) {
    const sessionDraft = createSessionDraft(metadata);
    const rotatedAt = new Date();
    const result = await repository.rotateSession({
      currentTokenHash: tokenManager.hashRefreshToken(refreshToken),
      replacementSession: sessionDraft.storedSession,
      rotatedAt,
    });

    if (!result) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    return buildAuthenticationResult(result.user, result.session.id, sessionDraft.refreshToken);
  }

  async function logout({ userId, sessionId }) {
    await repository.revokeSession({ userId, sessionId, revokedAt: new Date() });
  }

  async function logoutAll(userId) {
    await repository.revokeAllSessions({ userId, revokedAt: new Date() });
  }

  function createSessionDraft(metadata) {
    const refreshToken = tokenManager.generateRefreshToken();

    return {
      refreshToken,
      storedSession: {
        id: sessionIdGenerator(),
        tokenHash: tokenManager.hashRefreshToken(refreshToken),
        expiresAt: tokenManager.getRefreshTokenExpiry(),
        userAgent: truncateOptional(metadata.userAgent, 512),
        ipAddress: truncateOptional(metadata.ipAddress, 45),
      },
    };
  }

  async function buildAuthenticationResult(user, sessionId, refreshToken) {
    const accessToken = await tokenManager.signAccessToken({ userId: user.id, sessionId });

    return {
      user: toPublicUser(user),
      tokens: {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      },
    };
  }

  return { login, logout, logoutAll, refresh, register };
}

function truncateOptional(value, maximumLength) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximumLength) : null;
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export const authService = createAuthService({ repository: authRepository });
