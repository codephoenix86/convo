import { describe, expect, it, vi } from 'vitest';

import { createRedisFixedWindowRateLimiter } from '../../src/lib/redis-rate-limiter.js';

describe('Redis fixed-window rate limiter', () => {
  it('atomically consumes a namespaced counter and reports Redis TTL', async () => {
    const redisClient = { eval: vi.fn().mockResolvedValue([1, 4_250]) };
    const limiter = createRedisFixedWindowRateLimiter({
      redisClient,
      namespace: 'messageSend',
      limit: 2,
      windowMs: 5_000,
    });

    await expect(limiter.consume('user:user-id')).resolves.toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAfterMs: 4_250,
    });
    expect(redisClient.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['convo:rate-limit:messageSend:user:user-id'],
      arguments: ['5000'],
    });
  });

  it('fails closed after the shared budget is exhausted', async () => {
    const redisClient = { eval: vi.fn().mockResolvedValue([3, 2_000]) };
    const limiter = createRedisFixedWindowRateLimiter({
      redisClient,
      namespace: 'login',
      limit: 2,
      windowMs: 5_000,
    });

    await expect(limiter.consume('ip:127.0.0.1')).resolves.toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      resetAfterMs: 2_000,
    });
    redisClient.eval.mockRejectedValue(new Error('Redis unavailable'));
    await expect(limiter.consume('ip:127.0.0.1')).rejects.toThrow('Redis unavailable');
  });

  it('validates configuration and keys before issuing commands', async () => {
    const redisClient = { eval: vi.fn() };

    expect(() =>
      createRedisFixedWindowRateLimiter({
        redisClient,
        namespace: '',
        limit: 1,
        windowMs: 1_000,
      }),
    ).toThrow(TypeError);

    const limiter = createRedisFixedWindowRateLimiter({
      redisClient,
      namespace: 'search',
      limit: 1,
      windowMs: 1_000,
    });
    await expect(limiter.consume('')).rejects.toThrow(TypeError);
    expect(redisClient.eval).not.toHaveBeenCalled();
  });
});
