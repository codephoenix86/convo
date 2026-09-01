import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validate.js';
import { createAuthController } from './auth.controller.js';
import { loginBodySchema, refreshBodySchema, registerBodySchema } from './auth.validation.js';

export function createAuthRouter({ authentication, accessTokenVerifier }) {
  const router = Router();
  const controller = createAuthController(authentication);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);

  router.post('/register', validateBody(registerBodySchema), controller.register);
  router.post('/login', validateBody(loginBodySchema), controller.login);
  router.post('/refresh', validateBody(refreshBodySchema), controller.refresh);
  router.post('/logout', authenticate, controller.logout);
  router.post('/logout-all', authenticate, controller.logoutAll);

  return router;
}
