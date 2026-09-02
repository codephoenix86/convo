import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { createMessagesController } from './messages.controller.js';
import {
  conversationMessagesParamsSchema,
  createMessageBodySchema,
  messageHistoryQuerySchema,
} from './messages.validation.js';

export function createMessagesRouter({ messages, accessTokenVerifier }) {
  const router = Router();
  const controller = createMessagesController(messages);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.post(
    '/:id/messages',
    authenticate,
    validateParams(conversationMessagesParamsSchema),
    validateBody(createMessageBodySchema),
    controller.create,
  );
  router.get(
    '/:id/messages',
    authenticate,
    validateParams(conversationMessagesParamsSchema),
    validateQuery(messageHistoryQuerySchema),
    controller.listHistory,
  );

  return router;
}
