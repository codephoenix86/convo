import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../../src/lib/cursor.js';
import { ValidationError } from '../../src/lib/errors.js';

const cursorSchema = z.object({ id: z.uuid(), sequence: z.number().int() }).strict();
const cursorValue = { id: '01990a2d-6b80-7000-8000-000000000001', sequence: 42 };

describe('pagination cursors', () => {
  it('round-trips a validated opaque cursor', () => {
    const encoded = encodeCursor(cursorValue);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, cursorSchema)).toEqual(cursorValue);
  });

  it.each([
    'not+base64url',
    Buffer.from('{', 'utf8').toString('base64url'),
    encodeCursor({ sequence: 42 }),
    encodeCursor({ ...cursorValue, extra: true }),
  ])('rejects malformed or structurally invalid cursor %s', (cursor) => {
    expect(() => decodeCursor(cursor, cursorSchema)).toThrow(ValidationError);
  });
});
