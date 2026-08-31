import { randomUUID } from 'node:crypto';

import pinoHttp from 'pino-http';

import { logger } from '../config/logger.js';

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

export function createRequestLogger(rootLogger = logger) {
  return pinoHttp({
    logger: rootLogger,
    quietReqLogger: true,
    genReqId(request, response) {
      const incomingRequestId = request.headers['x-request-id'];
      const requestId = isValidRequestId(incomingRequestId) ? incomingRequestId : randomUUID();

      response.setHeader('x-request-id', requestId);

      return requestId;
    },
    customLogLevel(request, response, error) {
      void request;

      if (error || response.statusCode >= 500) {
        return 'error';
      }

      if (response.statusCode >= 400) {
        return 'warn';
      }

      return 'info';
    },
    customSuccessMessage() {
      return 'Request completed';
    },
    customErrorMessage() {
      return 'Request failed';
    },
    customProps(request) {
      return request.user?.id ? { userId: request.user.id } : {};
    },
  });
}

function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export const requestLogger = createRequestLogger();
