import { UnauthorizedError } from '../lib/errors.js';

const MAX_ACCESS_TOKEN_LENGTH = 8192;

export function createSocketAuthenticator(tokenVerifier, log) {
  return async function authenticateSocket(socket, next) {
    const token = readHandshakeToken(socket.handshake.auth);

    if (!token) {
      rejectAuthentication(socket, next, log);
      return;
    }

    try {
      const claims = await tokenVerifier(token);

      socket.data.user = Object.freeze({
        id: claims.userId,
        sessionId: claims.sessionId,
        tokenId: claims.tokenId,
      });

      next();
    } catch {
      rejectAuthentication(socket, next, log);
    }
  };
}

function readHandshakeToken(auth) {
  const token = auth?.token;

  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    token.trim() !== token
  ) {
    return null;
  }

  return token;
}

function rejectAuthentication(socket, next, log) {
  const unauthorizedError = new UnauthorizedError('Invalid or missing access token');
  const connectionError = new Error(unauthorizedError.message);

  connectionError.data = {
    code: unauthorizedError.code,
    message: unauthorizedError.message,
  };

  log.warn(
    {
      event: 'socket_authentication_failed',
      socketId: socket.id,
      transport: socket.conn.transport.name,
    },
    'Socket authentication failed',
  );

  next(connectionError);
}
