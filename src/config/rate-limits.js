import { createFixedWindowRateLimiter } from '../lib/rate-limiter.js';
import { createRedisFixedWindowRateLimiter } from '../lib/redis-rate-limiter.js';

const MINUTE_MS = 60_000;

export const RATE_LIMIT_POLICIES = Object.freeze({
  registration: Object.freeze({ limit: 5, windowMs: 15 * MINUTE_MS }),
  login: Object.freeze({ limit: 10, windowMs: 15 * MINUTE_MS }),
  userSearch: Object.freeze({ limit: 60, windowMs: MINUTE_MS }),
  messageSend: Object.freeze({ limit: 120, windowMs: MINUTE_MS }),
  uploadInit: Object.freeze({ limit: 20, windowMs: MINUTE_MS }),
});

export function createApplicationRateLimiters({ policies = {}, now = Date.now, redisClient } = {}) {
  return Object.fromEntries(
    Object.entries(RATE_LIMIT_POLICIES).map(([name, defaults]) => {
      const policy = { ...defaults, ...policies[name] };
      const limiter = redisClient
        ? createRedisFixedWindowRateLimiter({ redisClient, namespace: name, ...policy })
        : createFixedWindowRateLimiter({ ...policy, now });

      return [name, limiter];
    }),
  );
}
