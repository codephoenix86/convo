import { ValidationError } from './errors.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor, schema) {
  try {
    if (!BASE64URL_PATTERN.test(cursor)) {
      throw new Error('Cursor is not base64url encoded');
    }

    const serialized = Buffer.from(cursor, 'base64url');

    if (serialized.toString('base64url') !== cursor) {
      throw new Error('Cursor is not canonically encoded');
    }

    return schema.parse(JSON.parse(serialized.toString('utf8')));
  } catch {
    throw new ValidationError('Invalid pagination cursor', [
      { field: 'cursor', message: 'Cursor is invalid or does not match this request' },
    ]);
  }
}
