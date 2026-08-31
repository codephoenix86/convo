import express from 'express';

import { db } from './config/db.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createHealthRouter } from './modules/health/health.routes.js';

const JSON_BODY_LIMIT = '100kb';

export function createApp({ database = db } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('json escape', true);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.use(createHealthRouter({ database }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
