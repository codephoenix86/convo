import { Router } from 'express';
import express from 'express';

import { objectStorage } from '../../config/object-storage.js';
import { getUserRateLimitKey } from '../../lib/rate-limiter.js';
import { createAccessTokenAuthenticator } from '../../middleware/authenticate.js';
import { createRateLimitMiddleware } from '../../middleware/rate-limit.js';
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
  rateLimiters,
  storage = objectStorage,
}) {
  const router = Router();
  const controller = createAttachmentsController(attachments, storage);
  const limitUploadInitialization = createRateLimitMiddleware({
    limiter: rateLimiters.uploadInit,
    key: (request) => getUserRateLimitKey(request.user.id),
    message: 'Upload initialization attempts are too frequent',
  });

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
    limitUploadInitialization,
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
