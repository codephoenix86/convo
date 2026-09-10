import { Router } from 'express';

import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { createAttachmentsController } from './attachments.controller.js';
import { attachmentIdParamsSchema, initializeUploadBodySchema } from './attachments.validation.js';

export function createAttachmentsRouter({ attachments, accessTokenVerifier }) {
  const router = Router();
  const controller = createAttachmentsController(attachments);

  router.post(
    '/upload-init',
    createAccessTokenAuthenticator(accessTokenVerifier),
    validateBody(initializeUploadBodySchema),
    controller.initializeUpload,
  );
  router.get(
    '/:id/content',
    createAccessTokenAuthenticator(accessTokenVerifier),
    validateParams(attachmentIdParamsSchema),
    controller.download,
  );

  return router;
}
