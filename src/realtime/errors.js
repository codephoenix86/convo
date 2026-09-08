import { AppError } from '../lib/errors.js';

export function createSocketEventError(error) {
  if (error instanceof AppError) {
    const result = {
      code: error.code,
      message: error.message,
    };

    if (error.details !== undefined) {
      result.details = error.details;
    }

    return result;
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  };
}
