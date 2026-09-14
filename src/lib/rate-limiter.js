export function createFixedWindowRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}) {
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(windowMs, 'windowMs');
  requirePositiveInteger(maxKeys, 'maxKeys');

  const buckets = new Map();

  return {
    consume(key) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('Rate-limit key must be a non-empty string');
      }

      const currentTime = now();
      let bucket = buckets.get(key);

      if (!bucket || currentTime >= bucket.resetAt) {
        if (!bucket) {
          makeRoomForKey(buckets, currentTime, maxKeys);
        }

        bucket = { count: 0, resetAt: currentTime + windowMs };
        buckets.set(key, bucket);
      }

      if (bucket.count >= limit) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAfterMs: Math.max(0, bucket.resetAt - currentTime),
        };
      }

      bucket.count += 1;

      return {
        allowed: true,
        limit,
        remaining: limit - bucket.count,
        resetAfterMs: Math.max(0, bucket.resetAt - currentTime),
      };
    },

    clear() {
      buckets.clear();
    },
  };
}

export function getUserRateLimitKey(userId) {
  return `user:${userId}`;
}

function makeRoomForKey(buckets, currentTime, maxKeys) {
  if (buckets.size < maxKeys) {
    return;
  }

  for (const [key, bucket] of buckets) {
    if (currentTime >= bucket.resetAt) {
      buckets.delete(key);
    }
  }

  while (buckets.size >= maxKeys) {
    buckets.delete(buckets.keys().next().value);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}
