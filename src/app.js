import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { db } from './config/db.js';
import { env } from './config/env.js';
import { objectStorage } from './config/object-storage.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { createAttachmentsRouter } from './modules/attachments/attachments.routes.js';
import { attachmentsService } from './modules/attachments/attachments.service.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { authService } from './modules/auth/auth.service.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { conversationsService } from './modules/conversations/conversations.service.js';
import { createConversationsRouter } from './modules/conversations/conversations.routes.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import {
  createMessageMutationsRouter,
  createMessagesRouter,
} from './modules/messages/messages.routes.js';
import { messagesService } from './modules/messages/messages.service.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { usersService } from './modules/users/users.service.js';

const JSON_BODY_LIMIT = '100kb';
const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'X-Request-Id'];
const CORS_EXPOSED_HEADERS = ['X-Request-Id'];

export function createApp({
  database = db,
  authentication = authService,
  users = usersService,
  conversations = conversationsService,
  messages = messagesService,
  attachments = attachmentsService,
  attachmentStorage = objectStorage,
  accessTokenVerifier = verifyAccessToken,
  allowedOrigins = env.CLIENT_ORIGINS,
  registerRoutes,
  requestLogging = requestLogger,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('json escape', true);
  app.use(requestLogging);
  app.use(helmet());
  app.use(
    cors({
      origin: createCorsOriginValidator(allowedOrigins),
      methods: CORS_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.use(createHealthRouter({ database }));
  app.use('/auth', createAuthRouter({ authentication, accessTokenVerifier }));
  app.use('/users', createUsersRouter({ users, accessTokenVerifier }));
  app.use('/conversations', createConversationsRouter({ conversations, accessTokenVerifier }));
  app.use('/conversations', createMessagesRouter({ messages, accessTokenVerifier }));
  app.use('/messages', createMessageMutationsRouter({ messages, accessTokenVerifier }));
  app.use(
    '/attachments',
    createAttachmentsRouter({ attachments, accessTokenVerifier, storage: attachmentStorage }),
  );

  if (registerRoutes) {
    registerRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function createCorsOriginValidator(allowedOrigins) {
  const allowedOriginSet = new Set(allowedOrigins);

  return (origin, callback) => {
    callback(null, origin === undefined || allowedOriginSet.has(origin));
  };
}

export const app = createApp();
