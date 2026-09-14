import { describe, expect, it } from 'vitest';

import { createFixedWindowRateLimiter, getUserRateLimitKey } from '../../src/lib/rate-limiter.js';

describe('fixed-window rate limiter', () => {
  it('isolates keys, reports remaining capacity, and resets after the window', () => {
    let currentTime = 1_000;
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 5_000,
      now: () => currentTime,
    });

    expect(limiter.consume('first')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAfterMs: 5_000,
    });
    expect(limiter.consume('first')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 0,
      resetAfterMs: 5_000,
    });
    expect(limiter.consume('first')).toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      resetAfterMs: 5_000,
    });
    expect(limiter.consume('second').allowed).toBe(true);

    currentTime += 5_000;

    expect(limiter.consume('first')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAfterMs: 5_000,
    });
  });

  it('evicts old keys at its memory bound and validates configuration', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });

    limiter.consume('first');
    limiter.consume('second');
    limiter.consume('third');

    expect(limiter.consume('first').allowed).toBe(true);
    expect(() => createFixedWindowRateLimiter({ limit: 0, windowMs: 1_000 })).toThrow(TypeError);
    expect(() => limiter.consume('')).toThrow(TypeError);
  });

  it('creates a stable namespace for limits shared across transports', () => {
    expect(getUserRateLimitKey('user-id')).toBe('user:user-id');
  });
});
