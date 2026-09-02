import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { createConversationsController } from './conversations.controller.js';
import {
  addConversationMemberBodySchema,
  conversationIdParamsSchema,
  conversationMemberParamsSchema,
  createDirectConversationBodySchema,
  createGroupConversationBodySchema,
  listConversationsQuerySchema,
  updateConversationMemberRoleBodySchema,
  updateGroupConversationBodySchema,
} from './conversations.validation.js';

export function createConversationsRouter({ conversations, accessTokenVerifier }) {
  const router = Router();
  const controller = createConversationsController(conversations);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.post(
    '/direct',
    authenticate,
    validateBody(createDirectConversationBodySchema),
    controller.createDirect,
  );
  router.post(
    '/group',
    authenticate,
    validateBody(createGroupConversationBodySchema),
    controller.createGroup,
  );
  router.get('/', authenticate, validateQuery(listConversationsQuerySchema), controller.list);
  router.post(
    '/:id/members',
    authenticate,
    validateParams(conversationIdParamsSchema),
    validateBody(addConversationMemberBodySchema),
    controller.addMember,
  );
  router.delete(
    '/:id/members/:userId',
    authenticate,
    validateParams(conversationMemberParamsSchema),
    controller.removeMember,
  );
  router.patch(
    '/:id/members/:userId',
    authenticate,
    validateParams(conversationMemberParamsSchema),
    validateBody(updateConversationMemberRoleBodySchema),
    controller.updateMemberRole,
  );
  router.patch(
    '/:id',
    authenticate,
    validateParams(conversationIdParamsSchema),
    validateBody(updateGroupConversationBodySchema),
    controller.updateGroup,
  );

  return router;
}
