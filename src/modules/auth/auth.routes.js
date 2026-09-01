import { Router } from 'express';

import { validateBody } from '../../middleware/validate.js';
import { createAuthController } from './auth.controller.js';
import { loginBodySchema, registerBodySchema } from './auth.validation.js';

export function createAuthRouter({ authentication }) {
  const router = Router();
  const controller = createAuthController(authentication);

  router.post('/register', validateBody(registerBodySchema), controller.register);
  router.post('/login', validateBody(loginBodySchema), controller.login);

  return router;
}
