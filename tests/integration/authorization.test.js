import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const conversationId = randomUUID();
const targetUserId = randomUUID();
const messageId = randomUUID();
const attachmentId = randomUUID();
const clientMessageId = randomUUID();

const protectedRequests = [
  ['POST', '/auth/logout', (app) => request(app).post('/auth/logout')],
  ['POST', '/auth/logout-all', (app) => request(app).post('/auth/logout-all')],
  ['GET', '/users/me', (app) => request(app).get('/users/me')],
  [
    'PATCH',
    '/users/me',
    (app) => request(app).patch('/users/me').send({ username: 'updated_user' }),
  ],
  ['GET', '/users/search', (app) => request(app).get('/users/search').query({ q: 'user' })],
  [
    'POST',
    '/conversations/direct',
    (app) => request(app).post('/conversations/direct').send({ userId: targetUserId }),
  ],
  [
    'POST',
    '/conversations/group',
    (app) =>
      request(app)
        .post('/conversations/group')
        .send({ name: 'Private group', memberIds: [targetUserId] }),
  ],
  ['GET', '/conversations', (app) => request(app).get('/conversations')],
  [
    'PATCH',
    '/conversations/:id',
    (app) => request(app).patch(`/conversations/${conversationId}`).send({ name: 'Renamed group' }),
  ],
  [
    'POST',
    '/conversations/:id/members',
    (app) =>
      request(app).post(`/conversations/${conversationId}/members`).send({ userId: targetUserId }),
  ],
  [
    'DELETE',
    '/conversations/:id/members/:userId',
    (app) => request(app).delete(`/conversations/${conversationId}/members/${targetUserId}`),
  ],
  [
    'PATCH',
    '/conversations/:id/members/:userId',
    (app) =>
      request(app)
        .patch(`/conversations/${conversationId}/members/${targetUserId}`)
        .send({ role: 'ADMIN' }),
  ],
  [
    'POST',
    '/conversations/:id/messages',
    (app) =>
      request(app)
        .post(`/conversations/${conversationId}/messages`)
        .send({ clientMessageId, body: 'Private message' }),
  ],
  [
    'GET',
    '/conversations/:id/messages',
    (app) => request(app).get(`/conversations/${conversationId}/messages`),
  ],
  [
    'PUT',
    '/conversations/:id/read',
    (app) => request(app).put(`/conversations/${conversationId}/read`).send({ messageId }),
  ],
  [
    'PATCH',
    '/messages/:id',
    (app) => request(app).patch(`/messages/${messageId}`).send({ body: 'Unauthorized edit' }),
  ],
  ['DELETE', '/messages/:id', (app) => request(app).delete(`/messages/${messageId}`)],
  [
    'POST',
    '/attachments/upload-init',
    (app) =>
      request(app).post('/attachments/upload-init').send({
        conversationId,
        fileName: 'private.png',
        mimeType: 'image/png',
        size: 1024,
      }),
  ],
  [
    'GET',
    '/attachments/:id/content',
    (app) => request(app).get(`/attachments/${attachmentId}/content`),
  ],
];

describe('HTTP authentication boundary', () => {
  it.each(protectedRequests)(
    'rejects unauthenticated %s %s before domain logic',
    async (_method, _path, execute) => {
      const dependencies = createServiceDoubles();
      const accessTokenVerifier = vi.fn();
      const app = createApp({ ...dependencies, accessTokenVerifier });

      const response = await execute(app).expect(401);

      expect(response.body.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing access token',
        requestId: expect.any(String),
      });
      expect(accessTokenVerifier).not.toHaveBeenCalled();
      for (const serviceMethod of allServiceMethods(dependencies)) {
        expect(serviceMethod).not.toHaveBeenCalled();
      }
    },
  );
});

function createServiceDoubles() {
  return {
    authentication: createMethods('register', 'login', 'refresh', 'logout', 'logoutAll'),
    users: createMethods('getProfile', 'updateProfile', 'search'),
    conversations: createMethods(
      'createDirect',
      'createGroup',
      'updateGroup',
      'addMember',
      'removeMember',
      'updateMemberRole',
      'list',
    ),
    messages: createMethods('send', 'listHistory', 'markRead', 'edit', 'delete'),
    attachments: createMethods('initializeUpload', 'createDownload'),
  };
}

function createMethods(...names) {
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
}

function allServiceMethods(dependencies) {
  return Object.values(dependencies).flatMap(Object.values);
}
