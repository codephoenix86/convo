import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { createRateLimitMiddleware } from '../../middleware/rate-limit.js';
import { validateBody } from '../../middleware/validate.js';
import { createAuthController } from './auth.controller.js';
import { loginBodySchema, refreshBodySchema, registerBodySchema } from './auth.validation.js';

export function createAuthRouter({ authentication, accessTokenVerifier, rateLimiters }) {
  const router = Router();
  const controller = createAuthController(authentication);
  const authenticate = createAccessTokenAuthenticator(accessTokenVerifier);
  const limitRegistration = createRateLimitMiddleware({
    limiter: rateLimiters.registration,
    key: getClientKey,
    message: 'Registration attempts are too frequent',
  });
  const limitLogin = createRateLimitMiddleware({
    limiter: rateLimiters.login,
    key: getClientKey,
    message: 'Login attempts are too frequent',
  });

  router.post(
    '/register',
    limitRegistration,
    validateBody(registerBodySchema),
    controller.register,
  );
  router.post('/login', limitLogin, validateBody(loginBodySchema), controller.login);
  router.post('/refresh', validateBody(refreshBodySchema), controller.refresh);
  router.post('/logout', authenticate, controller.logout);
  router.post('/logout-all', authenticate, controller.logoutAll);

  return router;
}

function getClientKey(request) {
  return `ip:${request.ip}`;
}
