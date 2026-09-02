import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { createConversationsController } from './conversations.controller.js';
import {
  conversationIdParamsSchema,
  createDirectConversationBodySchema,
  createGroupConversationBodySchema,
  listConversationsQuerySchema,
  updateGroupConversationBodySchema,
} from './conversations.validation.js';

export function createConversationsRouter({ conversations, accessTokenVerifier }) {
  const router = Router();
  const controller = createConversationsController(conversations);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.use(authenticate);
  router.post('/direct', validateBody(createDirectConversationBodySchema), controller.createDirect);
  router.post('/group', validateBody(createGroupConversationBodySchema), controller.createGroup);
  router.get('/', validateQuery(listConversationsQuerySchema), controller.list);
  router.patch(
    '/:id',
    validateParams(conversationIdParamsSchema),
    validateBody(updateGroupConversationBodySchema),
    controller.updateGroup,
  );

  return router;
}
