import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';

describe('password hashing', () => {
  it('creates a salted Argon2id hash that verifies', async () => {
    const password = 'a-correct-horse-battery-staple';

    const firstHash = await hashPassword(password);
    const secondHash = await hashPassword(password);

    expect(firstHash).toMatch(/^\$argon2id\$/);
    expect(secondHash).not.toBe(firstHash);
    await expect(verifyPassword(firstHash, password)).resolves.toBe(true);
  });

  it('rejects a password that does not match the hash', async () => {
    const passwordHash = await hashPassword('correct-password');

    await expect(verifyPassword(passwordHash, 'wrong-password')).resolves.toBe(false);
  });
});
