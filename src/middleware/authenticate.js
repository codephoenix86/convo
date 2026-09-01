import { UnauthorizedError } from '../lib/errors.js';

const BEARER_TOKEN_PATTERN = /^Bearer ([^\s]+)$/i;

export function createAccessTokenAuthenticator(tokenVerifier) {
  return async function authenticateAccessToken(request, response, next) {
    void response;

    const authorization = request.get('authorization');
    const match = authorization?.match(BEARER_TOKEN_PATTERN);

    if (!match) {
      return next(new UnauthorizedError('Invalid or missing access token'));
    }

    try {
      const claims = await tokenVerifier(match[1]);

      request.user = {
        id: claims.userId,
        sessionId: claims.sessionId,
        tokenId: claims.tokenId,
      };

      return next();
    } catch {
      return next(new UnauthorizedError('Invalid or missing access token'));
    }
  };
}
