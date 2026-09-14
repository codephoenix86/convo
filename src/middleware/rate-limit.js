import { RateLimitError } from '../lib/errors.js';

export function createRateLimitMiddleware({ limiter, key, message }) {
  return function enforceRateLimit(request, response, next) {
    const result = limiter.consume(key(request));
    const resetAfterSeconds = Math.max(1, Math.ceil(result.resetAfterMs / 1000));

    response.set({
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(resetAfterSeconds),
    });

    if (!result.allowed) {
      response.set('Retry-After', String(resetAfterSeconds));
      return next(new RateLimitError(message));
    }

    return next();
  };
}
