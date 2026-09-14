import { Router } from 'express';

import { getUserRateLimitKey } from '../../lib/rate-limiter.js';
import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { createRateLimitMiddleware } from '../../middleware/rate-limit.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { createMessagesController } from './messages.controller.js';
import {
  conversationMessagesParamsSchema,
  createMessageBodySchema,
  editMessageBodySchema,
  markConversationReadBodySchema,
  messageIdParamsSchema,
  messageHistoryQuerySchema,
} from './messages.validation.js';

export function createMessagesRouter({ messages, accessTokenVerifier, rateLimiters }) {
  const router = Router();
  const controller = createMessagesController(messages);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);
  const limitMessageSend = createRateLimitMiddleware({
    limiter: rateLimiters.messageSend,
    key: (request) => getUserRateLimitKey(request.user.id),
    message: 'Message sends are too frequent',
  });

  router.post(
    '/:id/messages',
    authenticate,
    limitMessageSend,
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
  router.put(
    '/:id/read',
    authenticate,
    validateParams(conversationMessagesParamsSchema),
    validateBody(markConversationReadBodySchema),
    controller.markRead,
  );

  return router;
}

export function createMessageMutationsRouter({ messages, accessTokenVerifier }) {
  const router = Router();
  const controller = createMessagesController(messages);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.patch(
    '/:id',
    authenticate,
    validateParams(messageIdParamsSchema),
    validateBody(editMessageBodySchema),
    controller.edit,
  );
  router.delete('/:id', authenticate, validateParams(messageIdParamsSchema), controller.delete);

  return router;
}
