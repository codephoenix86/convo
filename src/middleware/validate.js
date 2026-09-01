import { ValidationError } from '../lib/errors.js';

export function validateBody(schema) {
  return function bodyValidationHandler(request, response, next) {
    void response;

    const result = schema.safeParse(request.body);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      }));

      return next(new ValidationError('Request body validation failed', details));
    }

    request.body = result.data;
    return next();
  };
}
