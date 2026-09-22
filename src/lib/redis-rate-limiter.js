const CONSUME_FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])

if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end

local ttl = redis.call('PTTL', KEYS[1])

if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

return { count, ttl }
`;

export function createRedisFixedWindowRateLimiter({ redisClient, namespace, limit, windowMs }) {
  requireRedisClient(redisClient);
  requireNonEmptyString(namespace, 'namespace');
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(windowMs, 'windowMs');

  return {
    async consume(key) {
      requireNonEmptyString(key, 'Rate-limit key');

      const [countValue, ttlValue] = await redisClient.eval(CONSUME_FIXED_WINDOW_SCRIPT, {
        keys: [`convo:rate-limit:${namespace}:${key}`],
        arguments: [String(windowMs)],
      });
      const count = Number(countValue);
      const resetAfterMs = Math.max(0, Number(ttlValue));

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAfterMs,
      };
    },
  };
}

function requireRedisClient(redisClient) {
  if (!redisClient || typeof redisClient.eval !== 'function') {
    throw new TypeError('redisClient must support eval');
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
