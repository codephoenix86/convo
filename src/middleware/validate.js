import { ValidationError } from '../lib/errors.js';

export function validateBody(schema) {
  return function bodyValidationHandler(request, response, next) {
    void response;

    const result = schema.safeParse(request.body);

    if (!result.success) {
      return next(
        createRequestValidationError(result.error, 'body', 'Request body validation failed'),
      );
    }

    request.body = result.data;
    return next();
  };
}

export function validateQuery(schema) {
  return function queryValidationHandler(request, response, next) {
    void response;

    const result = schema.safeParse(request.query);

    if (!result.success) {
      return next(createRequestValidationError(result.error, 'query'));
    }

    request.validated = { ...request.validated, query: result.data };
    return next();
  };
}

export function validateParams(schema) {
  return function paramsValidationHandler(request, response, next) {
    void response;

    const result = schema.safeParse(request.params);

    if (!result.success) {
      return next(createRequestValidationError(result.error, 'params'));
    }

    request.validated = { ...request.validated, params: result.data };
    return next();
  };
}

function createRequestValidationError(error, fallbackField, message = 'Request validation failed') {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.') || fallbackField,
    message: issue.message,
  }));

  return new ValidationError(message, details);
}
