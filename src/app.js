import express from 'express';

import { db } from './config/db.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { authService } from './modules/auth/auth.service.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { usersService } from './modules/users/users.service.js';

const JSON_BODY_LIMIT = '100kb';

export function createApp({
  database = db,
  authentication = authService,
  users = usersService,
  accessTokenVerifier = verifyAccessToken,
  registerRoutes,
  requestLogging = requestLogger,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('json escape', true);
  app.use(requestLogging);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.use(createHealthRouter({ database }));
  app.use('/auth', createAuthRouter({ authentication, accessTokenVerifier }));
  app.use('/users', createUsersRouter({ users, accessTokenVerifier }));

  if (registerRoutes) {
    registerRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
