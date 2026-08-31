export class AppError extends Error {
  constructor({ code, message, statusCode, details, cause }) {
    super(message, { cause });

    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details) {
    super({ code: 'VALIDATION_ERROR', message, statusCode: 400, details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required') {
    super({ code: 'UNAUTHORIZED', message, statusCode: 401 });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You are not allowed to perform this action') {
    super({ code: 'FORBIDDEN', message, statusCode: 403 });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super({ code, message, statusCode: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details) {
    super({ code: 'CONFLICT', message, statusCode: 409, details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body is too large') {
    super({ code: 'PAYLOAD_TOO_LARGE', message, statusCode: 413 });
  }
}
