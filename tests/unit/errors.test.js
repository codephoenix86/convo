import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  UnauthorizedError,
  ValidationError,
} from '../../src/lib/errors.js';

describe('application errors', () => {
  it.each([
    [new ValidationError(), 400, 'VALIDATION_ERROR'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new PayloadTooLargeError(), 413, 'PAYLOAD_TOO_LARGE'],
  ])('maps %s to its public HTTP contract', (error, statusCode, code) => {
    expect(error).toMatchObject({ statusCode, code });
  });

  it('keeps optional validation details', () => {
    const details = [{ field: 'email', message: 'Invalid email' }];

    expect(new ValidationError('Invalid input', details).details).toEqual(details);
  });
});
