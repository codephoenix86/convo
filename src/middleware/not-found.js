import { NotFoundError } from '../lib/errors.js';

export function notFoundHandler(request, response, next) {
  void request;
  void response;

  next(new NotFoundError('Route not found', 'ROUTE_NOT_FOUND'));
}
