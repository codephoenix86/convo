import { Server } from 'socket.io';

import { env } from '../config/env.js';

export function createSocketServer(httpServer, { allowedOrigins = env.CLIENT_ORIGINS } = {}) {
  const allowedOriginSet = new Set(allowedOrigins);

  return new Server(httpServer, {
    serveClient: false,
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin;

      callback(null, origin === undefined || allowedOriginSet.has(origin));
    },
  });
}
