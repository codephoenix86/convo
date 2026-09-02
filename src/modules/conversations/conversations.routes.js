import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { createConversationsController } from './conversations.controller.js';
import {
  createDirectConversationBodySchema,
  listConversationsQuerySchema,
} from './conversations.validation.js';

export function createConversationsRouter({ conversations, accessTokenVerifier }) {
  const router = Router();
  const controller = createConversationsController(conversations);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.use(authenticate);
  router.post('/direct', validateBody(createDirectConversationBodySchema), controller.createDirect);
  router.get('/', validateQuery(listConversationsQuerySchema), controller.list);

  return router;
}
