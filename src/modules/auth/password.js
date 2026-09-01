import * as argon2 from 'argon2';

const PASSWORD_HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
});

export function hashPassword(password) {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

export function verifyPassword(passwordHash, password) {
  return argon2.verify(passwordHash, password);
}
