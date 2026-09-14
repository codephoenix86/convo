import { Router } from 'express';

import { getUserRateLimitKey } from '../../lib/rate-limiter.js';
import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { createRateLimitMiddleware } from '../../middleware/rate-limit.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { createUsersController } from './users.controller.js';
import { searchUsersQuerySchema, updateProfileBodySchema } from './users.validation.js';

export function createUsersRouter({ users, accessTokenVerifier, rateLimiters }) {
  const router = Router();
  const controller = createUsersController(users);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);
  const limitSearch = createRateLimitMiddleware({
    limiter: rateLimiters.userSearch,
    key: (request) => getUserRateLimitKey(request.user.id),
    message: 'User searches are too frequent',
  });

  router.use(authenticate);
  router.get('/me', controller.getProfile);
  router.patch('/me', validateBody(updateProfileBodySchema), controller.updateProfile);
  router.get('/search', limitSearch, validateQuery(searchUsersQuerySchema), controller.search);

  return router;
}
