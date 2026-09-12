import { Router } from 'express';
import express from 'express';

import { objectStorage } from '../../config/object-storage.js';
import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { createAttachmentsController } from './attachments.controller.js';
import {
  attachmentIdParamsSchema,
  initializeUploadBodySchema,
  MAX_ATTACHMENT_BYTES,
} from './attachments.validation.js';

export function createAttachmentsRouter({
  attachments,
  accessTokenVerifier,
  storage = objectStorage,
}) {
  const router = Router();
  const controller = createAttachmentsController(attachments, storage);

  if (storage.driver === 'local') {
    router.put(
      '/local/upload',
      express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
      controller.uploadLocal,
    );
    router.get('/local/download', controller.downloadLocal);
  }

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
