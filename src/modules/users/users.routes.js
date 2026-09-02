import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { createUsersController } from './users.controller.js';
import { searchUsersQuerySchema, updateProfileBodySchema } from './users.validation.js';

export function createUsersRouter({ users, accessTokenVerifier }) {
  const router = Router();
  const controller = createUsersController(users);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.use(authenticate);
  router.get('/me', controller.getProfile);
  router.patch('/me', validateBody(updateProfileBodySchema), controller.updateProfile);
  router.get('/search', validateQuery(searchUsersQuerySchema), controller.search);

  return router;
}
