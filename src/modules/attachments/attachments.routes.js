import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validate.js';
import { createAttachmentsController } from './attachments.controller.js';
import { initializeUploadBodySchema } from './attachments.validation.js';

export function createAttachmentsRouter({ attachments, accessTokenVerifier }) {
  const router = Router();
  const controller = createAttachmentsController(attachments);

  router.post(
    '/upload-init',
    createAccessTokenAuthenticator(accessTokenVerifier),
    validateBody(initializeUploadBodySchema),
    controller.initializeUpload,
  );

  return router;
}
