import { AppError, PayloadTooLargeError, ValidationError } from '../lib/errors.js';

export function errorHandler(error, request, response, next) {
  void request;

  if (response.headersSent) {
    return next(error);
  }

  const normalizedError = normalizeError(error);
  const body = {
    error: {
      code: normalizedError.code,
      message: normalizedError.message,
    },
  };

  if (normalizedError.details !== undefined) {
    body.error.details = normalizedError.details;
  }

  return response.status(normalizedError.statusCode).json(body);
}

function normalizeError(error) {
  if (error instanceof AppError) {
    return error;
  }

  if (hasErrorType(error, 'entity.parse.failed')) {
    return new ValidationError('Request body contains malformed JSON');
  }

  if (hasErrorType(error, 'entity.too.large')) {
    return new PayloadTooLargeError();
  }

  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  });
}

function hasErrorType(error, type) {
  return error !== null && typeof error === 'object' && error.type === type;
}
