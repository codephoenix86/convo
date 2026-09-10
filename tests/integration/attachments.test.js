import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const userId = randomUUID();
const conversationId = randomUUID();
const accessClaims = { userId, sessionId: randomUUID(), tokenId: randomUUID() };
const upload = {
  storageKey: `conversations/${conversationId}/users/${userId}/${randomUUID()}.png`,
  method: 'PUT',
  url: 'https://storage.example.com/signed-upload',
  headers: { 'content-type': 'image/png' },
  expiresAt: new Date('2026-09-10T14:05:00.000Z'),
};

function createAuthenticatedApp(attachments) {
  return createApp({
    attachments,
    accessTokenVerifier: vi.fn().mockResolvedValue(accessClaims),
  });
}

describe('POST /attachments/upload-init', () => {
  it('returns a signed upload contract for validated metadata', async () => {
    const attachments = { initializeUpload: vi.fn().mockResolvedValue(upload) };

    const response = await request(createAuthenticatedApp(attachments))
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: '  photo.PNG  ',
        mimeType: 'image/png',
        size: 2048,
      })
      .expect(200);

    expect(attachments.initializeUpload).toHaveBeenCalledWith(userId, {
      conversationId,
      fileName: 'photo.PNG',
      mimeType: 'image/png',
      size: 2048,
    });
    expect(response.body.data.upload).toMatchObject({
      storageKey: upload.storageKey,
      method: 'PUT',
      url: upload.url,
      expiresAt: upload.expiresAt.toISOString(),
    });
  });

  it('rejects invalid metadata and unknown fields before service logic', async () => {
    const attachments = { initializeUpload: vi.fn() };
    const app = createAuthenticatedApp(attachments);

    await request(app)
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: 'payload.exe',
        mimeType: 'application/octet-stream',
        size: 100,
      })
      .expect(400);
    await request(app)
      .post('/attachments/upload-init')
      .set('authorization', 'Bearer valid-access-token')
      .send({
        conversationId,
        fileName: 'photo.png',
        mimeType: 'image/png',
        size: 100,
        userId,
      })
      .expect(400);

    expect(attachments.initializeUpload).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const attachments = { initializeUpload: vi.fn() };

    await request(createApp({ attachments }))
      .post('/attachments/upload-init')
      .send({ conversationId, fileName: 'photo.png', mimeType: 'image/png', size: 100 })
      .expect(401);

    expect(attachments.initializeUpload).not.toHaveBeenCalled();
  });
});
